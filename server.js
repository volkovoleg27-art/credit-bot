import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const BANK_OFFERS_PATH = path.join(__dirname, "bank_offers.json");
let BANK_OFFERS = JSON.parse(fs.readFileSync(BANK_OFFERS_PATH, "utf8"));

app.get("/health", (req, res) => res.json({ ok: true }));

function toNumber(x) {
  const n = Number(String(x).replace(/\s+/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}
function normalizeYesNo(x) {
  const s = String(x || "").trim().toLowerCase();
  if (["да","y","yes","true","1"].includes(s)) return true;
  if (["нет","n","no","false","0"].includes(s)) return false;
  return null;
}
function normalizeLoanType(x) {
  const s = String(x || "").trim().toLowerCase();
  const map = {
    "наличными": "cash","кредит наличными":"cash","cash":"cash",
    "авто":"auto","автокредит":"auto","auto":"auto",
    "ипотека":"mortgage","mortgage":"mortgage",
    "рефинанс":"refinance","рефинансирование":"refinance","refinance":"refinance"
  };
  return map[s] || null;
}
function normalizeCreditHistory(x) {
  const s = String(x || "").trim().toLowerCase();
  const map = { "хорошо":"good","good":"good","средне":"avg","avg":"avg","плохо":"bad","bad":"bad" };
  return map[s] || null;
}
function annuityPayment(principal, annualRate, months) {
  const r = annualRate / 12;
  if (r <= 0) return principal / months;
  const k = (r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
  return principal * k;
}

const steps = [
  "Привет! Выберите тип кредита: наличными / авто / ипотека / рефинанс",
  "Сколько вам лет?",
  "Какой у вас ежемесячный доход (в рублях, после налогов)?",
  "Какой стаж на текущем месте работы (в месяцах)?",
  "Как оцените кредитную историю? (хорошо / средне / плохо)",
  "Страховка подключается? (да / нет)",
  "Какую сумму хотите? (в рублях)",
  "На какой срок? (в месяцах)"
];

function initialState(){ return { step:0, profile:{} }; }

function buildOffers(profile) {
  const amount = Number(profile.desiredAmount || 0);
  const months = Number(profile.desiredMonths || 0);

  const list = BANK_OFFERS
    .filter(o => !profile.loanType || o.type === profile.loanType)
    .filter(o => (o.amountMin == null || amount >= o.amountMin))
    .filter(o => (o.amountMax == null || amount <= o.amountMax))
    .filter(o => (o.termMinMonths == null || months >= o.termMinMonths))
    .filter(o => (o.termMaxMonths == null || months <= o.termMaxMonths))
    .map(o => {
      const annualRate = (o.rateMin ?? o.rateMax ?? null);
      const canCalc = annualRate != null && amount > 0 && months >= 3;
      const monthlyPayment = canCalc ? annuityPayment(amount, annualRate, months) : null;
      const totalPay = monthlyPayment != null ? monthlyPayment * months : null;
      const overpay = totalPay != null ? totalPay - amount : null;
      return { ...o, title: `${o.bank} — ${o.product}`, annualRate, monthlyPayment, totalPay, overpay };
    });

  list.sort((a,b)=> (a.monthlyPayment ?? 1e18) - (b.monthlyPayment ?? 1e18));
  return list;
}

app.post("/api/chat", (req, res) => {
  try {
    const msgRaw = (req.body?.message ?? "").toString();
    const msg = msgRaw.trim();
    const state = (req.body?.state && typeof req.body.state === "object") ? req.body.state : initialState();
    const profile = (state.profile && typeof state.profile === "object") ? state.profile : {};
    let step = Number(state.step ?? 0);

    const reply = (text, offers=[]) => res.json({ reply: text, state: { step, profile }, offers });

    if (!msg || msg.toLowerCase()==="сброс" || msg==="/reset") {
      const ns = initialState();
      return res.json({ reply: steps[0], state: ns, offers: [] });
    }

    if (step===0){
      const t = normalizeLoanType(msg);
      if (!t) return reply("Напишите один из вариантов: наличными / авто / ипотека / рефинанс");
      profile.loanType=t; step=1; return reply(steps[1]);
    }
    if (step===1){
      const age = toNumber(msg);
      if (!Number.isFinite(age) || age<14 || age>100) return reply("Введите возраст числом (например 29).");
      profile.age=Math.round(age); step=2; return reply(steps[2]);
    }
    if (step===2){
      const income=toNumber(msg);
      if (!Number.isFinite(income) || income<5000) return reply("Введите доход числом (например 85000).");
      profile.income=Math.round(income); step=3; return reply(steps[3]);
    }
    if (step===3){
      const em=toNumber(msg);
      if (!Number.isFinite(em) || em<0) return reply("Введите стаж числом в месяцах (например 18).");
      profile.employmentMonths=Math.round(em); step=4; return reply(steps[4]);
    }
    if (step===4){
      const ch=normalizeCreditHistory(msg);
      if (!ch) return reply("Напишите: хорошо / средне / плохо");
      profile.creditHistory=ch; step=5; return reply(steps[5]);
    }
    if (step===5){
      const ins=normalizeYesNo(msg);
      if (ins===null) return reply("Ответьте “да” или “нет”.");
      profile.insurance=ins; step=6; return reply(steps[6]);
    }
    if (step===6){
      const amt=toNumber(msg);
      if (!Number.isFinite(amt) || amt<1000) return reply("Введите сумму числом (например 300000).");
      profile.desiredAmount=Math.round(amt); step=7; return reply(steps[7]);
    }
    if (step===7){
      const mo=toNumber(msg);
      if (!Number.isFinite(mo) || mo<3) return reply("Введите срок числом в месяцах (например 24).");
      profile.desiredMonths=Math.round(mo); step=8;

      const offers = buildOffers(profile);
      const fmt = (n)=> new Intl.NumberFormat("ru-RU",{style:"currency",currency:"RUB",maximumFractionDigits:0}).format(n);
      const typeLabel=(t)=>({cash:"Наличными",auto:"Авто",mortgage:"Ипотека",refinance:"Рефинанс"}[t]||t);

      const text =
        `Тип кредита: ${typeLabel(profile.loanType)}.\n` +
        `Сумма: ${fmt(profile.desiredAmount)} • Срок: ${profile.desiredMonths} мес.\n\n` +
        `Показал предложения с цифрами и ссылкой на первоисточник.\n` +
        `Платёж рассчитан по минимальной ставке из диапазона (если банк её публикует).`;

      return res.json({ reply: text, state: { step, profile }, offers });
    }

    if (msg.toLowerCase()==="ещё"){
      const offers = buildOffers(profile);
      return reply("Обновил список предложений.", offers);
    }

    return reply("Напишите “сброс”, чтобы начать заново, или “ещё”, чтобы обновить предложения.");
  } catch (e) {
    console.error("api/chat error:", e);
    return res.status(200).json({ reply: "Ошибка сервера. Напишите “сброс” и попробуйте снова.", state: initialState(), offers: [] });
  }
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}`));
