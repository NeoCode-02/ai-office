<p align="center">
  <img src="build/icon.png" width="88" alt="AI Office ikonkasi">
</p>

<h1 align="center">AI Office</h1>

<p align="center">
  AI modellar ofisdek birga ishlaydigan desktop ilova.<br>
  Siz maqsad berasiz. Bosh rahbar ishni bo‘ladi, jamoa bajaradi va tekshiradi, siz hisobot olasiz.
</p>

<p align="center"><a href="README.md">English</a></p>

![Ish ekrani](docs/work.png)

## Nima uchun

Bir nechta AI modelni birga ishlatish odatda ko‘p oyna ochib, javoblarni qo‘lda ko‘chirish degani. AI Office ularni bitta jamoaga yig‘adi:

- **Haqiqiy lavozimlar.** Har bir xodimning ismi, lavozimi, bo‘limi va boshlig‘i bor. Istalgan kasb: dasturchi, dizayner, yurist, buxgalter, pentester.
- **Modellarni aralashtiring.** Boshliqlarga kuchli model, ijrochilarga arzonroq model bering. Bitta model bir nechta lavozimda ishlay oladi.
- **Bir-biri bilan gaplashadi.** Boshliqlar topshiradi va tekshiradi, hamkasblar bo‘limlararo savol beradi, hisobot zanjir bo‘ylab yuqoriga boradi. Siz kokpit emas, sokin suhbatni ko‘rasiz.
- **Haqiqiy ish qiladi.** Fayl o‘qish, yozish, qidirish, buyruq ishlatish (sizning ruxsatingiz bilan), veb sahifa yuklash, skill va MCP asboblaridan foydalanish.
- **O‘rganadi.** Xodim saqlagan saboqlar keyingi ishlarda unga qaytariladi.
- **Nazorat sizda.** Plan rejimi (bosh rahbarning rejasi siz tasdiqlamaguningizcha hech narsa o‘zgarmaydi), "har doim ruxsat" bilan tasdiqlashlar, so‘rovlar limiti va xodimlar bir-biriga behuda yozishmasligi uchun himoya, har bir ofisga byudjet va butun ilova uchun kunlik/oylik xarajat chegarasi.
- **Bir bosishda qaytarish.** Har bir vazifa workspace snapshot'idan boshlanadi: o‘zgargan har bir fayl va diff ko‘rinadi, bitta faylni yoki hammasini qaytarish yoki natijani o‘z Git repo'ingizga commit qilish mumkin.

## Ishga tushirish

Node.js 22 yoki yangisi kerak.

```bash
git clone https://github.com/NeoCode-02/ai-office.git
cd ai-office
npm install
npm run dev
```

Yoki [Releases](https://github.com/NeoCode-02/ai-office/releases) sahifasidan o‘rnatuvchini yuklab oling. Hozircha imzolanmagan, shuning uchun birinchi ochishda Windows/macOS "noma’lum nashriyotchi" ogohlantirishini ko‘rsatadi.

1. **Sozlamalar → AI provayderlar** — API kalit qo‘shing: Anthropic (Claude), OpenAI, Google Gemini, DeepSeek, Kimi, GLM, OpenRouter, xAI, Mistral, Groq, Ollama yoki istalgan OpenAI-compatible manzil.
2. **Yangi ofis** — ish papkasi va jamoa shablonini tanlang.
3. **Ish** — bosh rahbarga nima kerakligini yozing. So‘ralganda buyruqlarga ruxsat bering. Yakuniy hisobotni o‘qing.

## Xarajat va limitlar

Har bir so‘rov provayder qaytargan tokenlar bilan yoziladi. **Statistika** sahifasida kunlik, model va xodim kesimidagi xarajat ko‘rinadi.

- **To‘lov turi har bir provayderda alohida:** token uchun (model narxlari bilan), obuna (oylik qat’iy to‘lov va ixtiyoriy tarif limiti, masalan "5 soatda 120 so‘rov") yoki bepul (lokal modellar).
- **Narx provayder ichida har bir model uchun.** Claude narxlari ichida tayyor. Boshqa modellar uchun narxni qo‘lda kiritasiz yoki OpenRouter ochiq katalogidan to‘ldirasiz (faqat aniq moslik bo‘lsa). Keshdan o‘qish va keshga yozish alohida hisoblanadi. Narxi yo‘q model $0 emas, *noma’lum* deb ko‘rsatiladi.
- **Qolgan balans** provayder API orqali bersa, to‘g‘ridan-to‘g‘ri olinadi (DeepSeek, Kimi, OpenRouter kalit limiti). Qolganlarida oylik yoki tarif limitingizni kiritasiz va u shu ilovadagi ishlatish bo‘yicha kuzatiladi.
- **Model ishlamay qolsa:** so‘rovlar limiti va provayder nosozligida avtomatik qayta urinadi (6 martagacha, `retry-after` bo‘yicha). Balans tugasa, kalit rad etilsa yoki model topilmasa, xodim qilgan ishi jurnali bilan **zaxira modelga** o‘tadi. Zaxira bo‘lmasa xodim to‘xtaydi va sizdan qayta urinish yoki boshqa model tanlashni so‘raydi; run ochiq qoladi.

![Statistika](docs/usage.png)

## Jamoa bilan ishlash

- **Plan rejimi** (ofis sozlamalari): bosh rahbar `propose_plan` bilan reja yuboradi va siz tasdiqlamaguningizcha faqat o‘qiy oladi: fayl yozmaydi, buyruq ishlatmaydi, MCP asboblaridan foydalanmaydi va ish topshirmaydi. Siz tasdiqlaysiz yoki fikr bildirasiz.
- **Tasdiqlash**: buyruqlar, MCP asboblari va shu kompyuter yoki lokal tarmoqqa so‘rovlar oldin so‘raladi. "Har doim ruxsat" bu ofis uchun buyruqni (qo‘shimcha argumentlari bilan ham), asbobni yoki hostni eslab qoladi; ro‘yxat ofis sozlamalarida.
- **O‘zgarishlar**: panelda vazifa qo‘shgan, o‘zgartirgan yoki o‘chirgan fayllar diff bilan ko‘rinadi. Bitta faylni yoki hammasini qaytarish mumkin; snapshot'lar alohida repo'da saqlanadi, sizning `.git` papkangizga tegilmaydi. 20 000 dan ortiq fayl yoki 1 GB dan katta workspace snapshot qilinmaydi (vazifa baribir ishlaydi).
- **Uzun vazifalar**: xodim suhbati uzayib ketsa, u qisqa xulosaga aylantirilib qayta boshlanadi (compaction), shuning uchun uzoq ish model limitiga urilmaydi.
- **Docker sandbox** (ixtiyoriy, ofis sozlamalari): `run_command` konteynerda ishlaydi — faqat workspace ulanadi (`.git` faqat o‘qish uchun), ruxsat bermasangiz tarmoq yo‘q.
- **Tarix**: oldingi vazifalarni qidirish, Markdown'ga eksport qilish yoki butun ofisni (jamoa, brifing, sozlamalar) ulashish uchun eksport qilish. Import qilinganda ruxsatlar va MCP kirishi o‘tmaydi.
- **Bildirishnoma va mavzu**: oyna orqada bo‘lsa desktop bildirishnomalari (tasdiqlash, reja, to‘xtagan xodim, yakuniy hisobot, to‘xtash), yorug‘/qorong‘i/tizim mavzusi va kuniga bir marta yangilanishni tekshirish (Sozlamalar → Umumiy).

## Kengaytmalar

Hammasi kengaytmasiz ishlaydi. Kerak bo‘lsa **Sozlamalar → Kengaytmalar**:

- **MCP serverlar** — GitHub, ma’lumotlar bazasi, brauzer kabi asboblar (lokal stdio yoki masofaviy HTTP). Serverni qo‘shing va qaysi xodim ishlatishini belgilang.
- **Skilllar** — Agent Skills formatidagi bilim (SKILL.md li papka). To‘rttasi ilova ichida tayyor.
- **Plaginlar** — Claude Code plagin tuzilmasidagi papkalar: `skills/`, `.mcp.json` va `agents/` (rol shablonlari) qo‘shiladi.

## Xavfsizlik

- API kalitlar va MCP sirlari operatsion tizim shifrlashi (`safeStorage`) bilan saqlanadi.
- Fayl asboblari faqat ofisning ish papkasi ichida ishlaydi: symlink'lar (hali mavjud bo‘lmagan papkalarda ham) hal qilinadi, `.git` ichiga yozish, FIFO va qurilmalarga yozish rad etiladi; bir workspace'da buyruq ishlayotganda fayl asboblari kutadi.
- `web_fetch` har bir hostni bir marta resolve qilib, manzilni qotiradi. Link-local, multicast va zahiradagi manzillar (bulut metadata servislari) hech qachon ochilmaydi; shu kompyuter (o‘z public manzillari ham) va lokal tarmoq uchun ruxsatingiz so‘raladi. Javob 2 MB bilan cheklangan.
- Terminal buyruqlari, MCP chaqiruvlari va lokal so‘rovlar sukut bo‘yicha sizdan so‘raladi. **Avtomatik rejim ham, MCP serverlar ham sandbox emas** — ular sizning huquqlaringiz bilan ishlaydi. Ixtiyoriy Docker sandbox faqat `run_command` ni o‘z ichiga oladi.
- Main process faqat o‘z oynasiga javob beradi va har bir argument shaklini tekshiradi.
- Import qilingan skill/plagin/ofis, yuklangan veb sahifa va fayllar matni modellarga beriladi — faqat ishonchli manbalarni ishlating.

Zaiflik haqida xabar berish: [SECURITY.md](SECURITY.md).

## Litsenziya

[MIT](LICENSE)
