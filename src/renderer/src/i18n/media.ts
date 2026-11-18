/**
 * Message box additions: attached files. Owner: work/Composer.tsx, Work.tsx.
 * English first; `uz` must have exactly the same keys (TypeScript checks it).
 */
const en = {
  attach: 'Attach files',
  removeFile: (name: string) => `Remove ${name}`,
  dropHere: 'Drop files to attach them',
  attachNote: 'Attached files are copied into the workspace’s attachments folder. Images and PDFs are shown to the models as they are.'
}

const uz: typeof en = {
  attach: 'Fayl biriktirish',
  removeFile: (name: string) => `${name} — olib tashlash`,
  dropHere: 'Biriktirish uchun fayllarni shu yerga tashlang',
  attachNote: 'Biriktirilgan fayllar ish papkasidagi attachments papkasiga nusxalanadi. Rasm va PDF’larni modellar o‘zi ko‘radi.'
}

export default { en, uz }
