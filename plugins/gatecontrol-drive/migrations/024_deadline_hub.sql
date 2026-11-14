-- Drive 1.30.0: who reminds of a deadline — Drive itself or „Notizen & Aufgaben“ (server/duehub.js).
--
-- handed_at: when the hub took this reminder (it rings it, Drive sends none of its own); NULL: Drive's own, as ever.
-- Adding the column writes no row; every reminder there is stays Drive's own.
ALTER TABLE doc_reminders ADD COLUMN handed_at INTEGER;
