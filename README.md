# AI Office

Turli AI modellardan iborat "ofis": har bir model — lavozimi, bo'limi va boshlig'i bor xodim. Siz faqat brifing va maqsad berasiz; bosh rahbar (CEO) ishni bo'limlarga bo'ladi, boshliqlar xodimlarga topshiradi va tekshiradi, xodimlar fayl yozadi, buyruq ishlatadi, bir-biridan so'raydi, yakunda sizga hisobot keladi. Hammasi bitta oynada jonli ko'rinadi — txt fayl bilan javob tashish yo'q.

## Ishga tushirish

```bash
npm install
npm run dev
```

Talab: Node.js 22+. Qo'shimcha plagin yoki skill kerak emas.

## Qanday ishlaydi

1. **AI provayderlar** — API kalit qo'shing: Anthropic (Claude), OpenAI, Google Gemini, DeepSeek, Kimi, GLM, OpenRouter, xAI, Mistral, Groq, Ollama yoki istalgan OpenAI-compatible endpoint. Kalitlar Windows DPAPI (`safeStorage`) bilan shifrlanib, faqat shu kompyuterda saqlanadi.
2. **Ofis** — nom, ish papkasi (workspace) va kompaniya brifingi.
3. **Jamoa** — tashkiliy tuzilma: istalgan lavozim (Software Engineer, Pentester, Lawyer, Accountant…), bo'lim, boshliq. Bitta modelni istalgancha xodimga berish mumkin. Har xodimga ruxsat etilgan asboblar alohida.
4. **Ofis** tabida maqsadni yozing va kuzating. Terminal buyruqlari sukut bo'yicha sizdan so'raladi; byudjet tugasa ish to'xtaydi. Ish tugagach yozishda davom etsangiz, jamoa davom etadi.

Xodimlar `remember` orqali saqlagan saboqlar keyingi ishlarda ularning promptiga qo'shiladi.

## Xavfsizlik

- Fayl asboblari ish papkasidan tashqariga chiqolmaydi (symlink ham tekshiriladi).
- `run_command` sandbox emas: "Avtomatik ruxsat" rejimini faqat ishonchli vazifalar uchun yoqing.

## Buyruqlar

| Buyruq | Vazifa |
|---|---|
| `npm run dev` | Dev rejim (HMR) |
| `npm run build` | Production build (`out/`) |
| `npm start` | Build'ni ishga tushirish |
| `npm run lint` / `npm run typecheck` / `npm test` | Tekshiruvlar |

`AI_OFFICE_DATA=<papka>` — ma'lumotlarni boshqa papkada saqlash (test yoki portable).

## Hozircha yo'q

- Token streaming (javob tayyor bo'lganda chiqadi, "ishlamoqda…" holati ko'rinadi).
- Ilova qayta ochilganda eski ishni davom ettirish (tarixdan faqat ko'rish mumkin).
- O'rnatuvchi (installer) — imzosiz `.exe` Windows Smart App Control'da bloklanishi mumkin.
