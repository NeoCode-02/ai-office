/**
 * Message box additions: attached files. Owner: work/Composer.tsx, Work.tsx.
 * English first; `uz` must have exactly the same keys (TypeScript checks it).
 */
const en = {
  attach: 'Attach files',
  removeFile: (name: string) => `Remove ${name}`,
  dropHere: 'Drop files to attach them',
  attachNote: 'Attached files are copied into the workspace’s attachments folder. Images and PDFs are shown to the models as they are.',
  mic: 'Hold to speak',
  transcribing: 'Turning speech into text…',
  recording: (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · release to send, Esc to cancel`,
  tooShort: 'Hold the button while you speak.',
  heardNothing: 'No speech was heard.',
  noMic: 'The microphone isn’t available. Check that one is connected and that Windows lets apps use it (Settings → Privacy & security → Microphone).',
  voice: 'Voice',
  voiceHint: 'Speak to the team: hold the microphone button in the message box.',
  stt: 'Speech to text',
  sttHint: 'An OpenAI or Groq key works (Groq has a free tier). Your recordings are sent to this provider.',
  sttOff: 'Off',
  sttNone: 'Add an OpenAI or Groq provider with a key first.',
  sttModel: 'Speech model',
  sttModelHint: 'Leave empty for the provider’s usual model.'
}

const uz: typeof en = {
  attach: 'Fayl biriktirish',
  removeFile: (name: string) => `${name} — olib tashlash`,
  dropHere: 'Biriktirish uchun fayllarni shu yerga tashlang',
  attachNote: 'Biriktirilgan fayllar ish papkasidagi attachments papkasiga nusxalanadi. Rasm va PDF’larni modellar o‘zi ko‘radi.',
  mic: 'Gapirish uchun bosib turing',
  transcribing: 'Ovoz matnga aylantirilmoqda…',
  recording: (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · yuborish uchun qo‘yib yuboring, bekor qilish — Esc`,
  tooShort: 'Gapirayotganda tugmani bosib turing.',
  heardNothing: 'Ovoz eshitilmadi.',
  noMic: 'Mikrofon topilmadi. U ulanganini va Windows ilovalarga undan foydalanishga ruxsat berganini tekshiring (Sozlamalar → Maxfiylik va xavfsizlik → Mikrofon).',
  voice: 'Ovoz',
  voiceHint: 'Jamoaga gapiring: xabar maydonidagi mikrofon tugmasini bosib turing.',
  stt: 'Ovozdan matnga',
  sttHint: 'OpenAI yoki Groq kaliti ishlaydi (Groq’da bepul tarif bor). Yozuvlaringiz shu provayderga yuboriladi.',
  sttOff: 'O‘chiq',
  sttNone: 'Avval kaliti bor OpenAI yoki Groq provayderini qo‘shing.',
  sttModel: 'Ovoz modeli',
  sttModelHint: 'Bo‘sh qolsa provayderning odatiy modeli ishlatiladi.'
}

export default { en, uz }
