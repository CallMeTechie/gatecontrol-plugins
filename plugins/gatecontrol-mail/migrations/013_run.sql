-- Mail 1.13.1: the statement of the background run that still read every mail, every 15 s.
--
-- The AI's sorting (ai.tick) asks for the unclear mails — `ai_pending = 1 AND tab_by = 'rule'`, newest first. There are
-- usually none, and to find that out SQLite walked all mails along messages_date and read each row (protocol of
-- 13. 11.: 1138 ms for 0 rows on a slow disk). A partial index holds exactly these mails: empty most of the time.
CREATE INDEX messages_ai_pending ON messages (date) WHERE ai_pending = 1 AND tab_by = 'rule';
