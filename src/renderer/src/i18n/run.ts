/**
 * Work view additions: live replies, tool details, approvals, plan, changes, history, budget. Owner: Work.tsx and its parts.
 * English first; `uz` must have exactly the same keys (TypeScript checks it).
 */
const en = {
  changes: 'Changes',
  changesAria: (n: number | null) => (n === null ? 'Changes' : `Changes: ${n} ${n === 1 ? 'file' : 'files'}`),
  changedFiles: (n: number) => (n === 1 ? '1 file changed' : `${n} files changed`),
  checking: 'Looking for changes…',
  noChanges: 'No files in the workspace have changed.',
  pastNote: 'Compared with the workspace as it was when this task started, so changes made by later tasks show here too.',
  refresh: 'Refresh',
  fileStatus: { added: 'Added', modified: 'Changed', deleted: 'Deleted' },
  binary: 'binary',
  allFiles: 'All files',
  loadingDiff: 'Loading the differences…',
  noDiff: 'No text differences to show.',
  undo: 'Undo',
  undoFile: (path: string) => `Undo the changes to ${path}`,
  undoAll: 'Undo all',
  confirmUndo: 'Click again to undo',
  undone: 'Changes undone',
  stopFirst: 'Stop the work first',
  commit: 'Commit to repository…',
  commitMessage: 'Commit message',
  commitDo: 'Commit',
  committing: 'Committing…',
  committed: (sha: string) => `Committed ${sha}`,
  notRepo: 'The workspace is not a Git repository, so there is nowhere to commit. Run “git init” in the folder first, or keep the files as they are.',

  approvalFetch: (name: string) => `${name} wants to open a web address`,
  fetchNote: 'The address itself can carry data out of the workspace, and addresses on this computer or your local network can reach private services. Allow it only if you expect it.',
  filesSince: 'Files changed since the last approved command:',
  andMore: (n: number) => `and ${n} more`,
  inDocker: 'in Docker',
  dockerNote: 'Runs in a Docker container that sees only the workspace folder',
  alwaysAllow: 'Always allow',
  alwaysCommand: (cmd: string) => `Don’t ask again in this office for “${cmd}” (also with more arguments)`,
  alwaysTool: 'Don’t ask again in this office for this tool',
  alwaysHost: (host: string) => `Don’t ask again in this office for ${host}`,
  allowedAlways: 'Allowed for good',
  shortcut: (action: string, key: string) => `${action} (Alt+${key})`,

  planTitle: (name: string) => `${name}’s plan`,
  approvePlan: 'Approve plan',
  requestChanges: 'Request changes',
  feedback: 'What should change?',
  feedbackPlaceholder: 'Tell them what to change in the plan…',
  sendFeedback: 'Send',
  planApproved: 'Plan approved',
  planChanges: 'Changes requested',
  planReplaced: 'Replaced by a newer plan',
  planUnanswered: 'Not answered',
  waitingPlan: 'Waiting for plan approval',

  liveLabel: 'Replies being written',
  thinking: (secs: number | null) => (secs === null ? 'thinking…' : `thinking… ${secs} s`),
  writing: 'writing…',

  budgetUsed: (pct: number) => `${pct}% of the budget used`,
  budgetOut: (usd: string) => `The budget of $${usd} is used up.`,
  newBudget: 'New budget, USD',
  budgetRule: (spent: string) => `More than ${spent} (already spent), or 0 for no limit`,
  raise: 'Raise budget',
  raiseAndSend: 'Raise and send',
  budgetSaved: 'Budget raised. Write a message to continue.',

  reasons: {
    limit: (n: number) => `Stopped after ${n} model requests, the limit for one task. Raise it in the office settings, then write to continue.`,
    loop: (names: string[]) =>
      names.length
        ? `Stopped: ${names.join(' and ')} kept messaging each other without doing any work`
        : 'Stopped: members kept messaging each other without doing any work',
    cap: (usd: number) => `Spending cap reached ($${usd.toFixed(2)}). Raise it in Settings → General.`,
    plan: 'Waiting for your approval of the plan',
    app_closed: 'The app was closed while the team was working'
  },
  compacted: (name: string) => `${name}’s conversation was summarized to save space`,
  compactAt: (tokens: string) => `At ${tokens} tokens`,

  search: 'Search tasks',
  noMatches: 'No task matches your search.',
  loading: 'Loading…',
  exportMd: 'Export as Markdown',
  exported: (path: string) => `Saved to ${path}`,
  runAgain: 'Run again',
  deleteRun: 'Delete task',
  deleted: 'Task deleted',

  copyCode: (lang: string) => `Copy ${lang} code`
}

const uz: typeof en = {
  changes: 'O‘zgarishlar',
  changesAria: (n: number | null) => (n === null ? 'O‘zgarishlar' : `O‘zgarishlar: ${n} ta fayl`),
  changedFiles: (n: number) => `${n} ta fayl o‘zgardi`,
  checking: 'O‘zgarishlar qidirilmoqda…',
  noChanges: 'Ish papkasida hech bir fayl o‘zgarmagan.',
  pastNote: 'Ish papkasi shu vazifa boshlangandagi holati bilan solishtiriladi, shuning uchun keyingi vazifalarning o‘zgarishlari ham shu yerda ko‘rinadi.',
  refresh: 'Yangilash',
  fileStatus: { added: 'Qo‘shildi', modified: 'O‘zgardi', deleted: 'O‘chirildi' },
  binary: 'binar',
  allFiles: 'Barcha fayllar',
  loadingDiff: 'Farqlar yuklanmoqda…',
  noDiff: 'Ko‘rsatiladigan matn farqi yo‘q.',
  undo: 'Qaytarish',
  undoFile: (path: string) => `${path} faylidagi o‘zgarishlarni qaytarish`,
  undoAll: 'Hammasini qaytarish',
  confirmUndo: 'Qaytarish uchun yana bosing',
  undone: 'O‘zgarishlar qaytarildi',
  stopFirst: 'Avval ishni to‘xtating',
  commit: 'Repozitoriyga commit qilish…',
  commitMessage: 'Commit xabari',
  commitDo: 'Commit qilish',
  committing: 'Commit qilinmoqda…',
  committed: (sha: string) => `Commit qilindi: ${sha}`,
  notRepo: 'Ish papkasi Git repozitoriysi emas, shuning uchun commit qiladigan joy yo‘q. Avval papkada “git init” buyrug‘ini bajaring yoki fayllarni shundayligicha qoldiring.',

  approvalFetch: (name: string) => `${name} veb manzilni ochmoqchi`,
  fetchNote: 'Manzilning o‘zi ish papkasidagi ma’lumotni tashqariga olib chiqishi, bu kompyuter yoki lokal tarmoqdagi manzillar esa ichki xizmatlarga yetib borishi mumkin. Faqat buni kutgan bo‘lsangiz ruxsat bering.',
  filesSince: 'Oxirgi ruxsat berilgan buyruqdan keyin o‘zgargan fayllar:',
  andMore: (n: number) => `va yana ${n} ta`,
  inDocker: 'Docker ichida',
  dockerNote: 'Faqat ish papkasini ko‘radigan Docker konteynerida bajariladi',
  alwaysAllow: 'Doim ruxsat berish',
  alwaysCommand: (cmd: string) => `Bu ofisda “${cmd}” uchun (qo‘shimcha argumentlar bilan ham) boshqa so‘ralmasin`,
  alwaysTool: 'Bu ofisda shu asbob uchun boshqa so‘ralmasin',
  alwaysHost: (host: string) => `Bu ofisda ${host} uchun boshqa so‘ralmasin`,
  allowedAlways: 'Doimiy ruxsat berildi',
  shortcut: (action: string, key: string) => `${action} (Alt+${key})`,

  planTitle: (name: string) => `${name} rejasi`,
  approvePlan: 'Rejani tasdiqlash',
  requestChanges: 'O‘zgartirish so‘rash',
  feedback: 'Nimani o‘zgartirish kerak?',
  feedbackPlaceholder: 'Rejada nimani o‘zgartirish kerakligini yozing…',
  sendFeedback: 'Yuborish',
  planApproved: 'Reja tasdiqlandi',
  planChanges: 'O‘zgartirish so‘raldi',
  planReplaced: 'Yangi reja bilan almashtirildi',
  planUnanswered: 'Javob berilmagan',
  waitingPlan: 'Reja tasdig‘ini kutmoqda',

  liveLabel: 'Yozilayotgan javoblar',
  thinking: (secs: number | null) => (secs === null ? 'o‘ylamoqda…' : `o‘ylamoqda… ${secs} s`),
  writing: 'yozmoqda…',

  budgetUsed: (pct: number) => `Byudjetning ${pct}% sarflandi`,
  budgetOut: (usd: string) => `$${usd} byudjet tugadi.`,
  newBudget: 'Yangi byudjet, USD',
  budgetRule: (spent: string) => `${spent} dan ko‘p (shuncha sarflangan) yoki cheklovsiz uchun 0`,
  raise: 'Byudjetni oshirish',
  raiseAndSend: 'Oshirib yuborish',
  budgetSaved: 'Byudjet oshirildi. Davom ettirish uchun xabar yozing.',

  reasons: {
    limit: (n: number) => `Bitta vazifa uchun so‘rovlar limiti tugadi (${n} ta so‘rov). Uni ofis sozlamalarida oshirib, davom ettirish uchun xabar yozing.`,
    loop: (names: string[]) =>
      names.length
        ? `To‘xtatildi: ${names.join(' va ')} hech ish qilmasdan bir-biriga xabar yozaverdi`
        : 'To‘xtatildi: xodimlar hech ish qilmasdan bir-biriga xabar yozaverdi',
    cap: (usd: number) => `Xarajat chegarasiga yetildi ($${usd.toFixed(2)}). Uni Sozlamalar → Umumiy bo‘limida oshiring.`,
    plan: 'Rejani tasdiqlashingizni kutmoqda',
    app_closed: 'Jamoa ishlayotganda ilova yopildi'
  },
  compacted: (name: string) => `Joy tejash uchun ${name} suhbati qisqacha xulosaga aylantirildi`,
  compactAt: (tokens: string) => `${tokens} tokenga yetganda`,

  search: 'Vazifalarni qidirish',
  noMatches: 'Qidiruvga mos vazifa yo‘q.',
  loading: 'Yuklanmoqda…',
  exportMd: 'Markdown sifatida eksport qilish',
  exported: (path: string) => `Saqlandi: ${path}`,
  runAgain: 'Qayta bajarish',
  deleteRun: 'Vazifani o‘chirish',
  deleted: 'Vazifa o‘chirildi',

  copyCode: (lang: string) => `${lang} kodidan nusxa olish`
}

export default { en, uz }
