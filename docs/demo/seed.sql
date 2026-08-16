-- Demo data for documentation screenshots. Entirely fictional: the domain is
-- example.com, the senders are invented, and no real address appears.
DELETE FROM email_labels;
DELETE FROM emails;
DELETE FROM labels;
DELETE FROM aliases;
DELETE FROM users;

-- Note: aliases.user_id and labels.user_id hold the signed-in *email*, not a
-- users.id — the API filters on it directly. It must match ADMIN_EMAIL in
-- .dev.vars or the sidebar comes up empty.
INSERT INTO users (id, email, created_at) VALUES ('u_demo', 'dev@localhost', 1786800000);

INSERT INTO aliases (id, user_id, local_part, domain, label, note, is_enabled, is_auto, created_at) VALUES
  ('a_netflix',  'dev@localhost', 'netflix',     'example.com', 'Streaming',  'signup 2026', 1, 0, 1786100000),
  ('a_bank',     'dev@localhost', 'bank',        'example.com', 'Finance',    '',            1, 0, 1786200000),
  ('a_news',     'dev@localhost', 'news',        'example.com', 'Reading',    '',            1, 0, 1786300000),
  ('a_shop',     'dev@localhost', 'toko-sekali', 'example.com', '',           'one-off',     1, 1, 1786400000),
  ('a_gh',       'dev@localhost', 'github',      'example.com', 'Dev',        '',            1, 1, 1786500000),
  ('a_spam',     'dev@localhost', 'promo2024',   'example.com', '',           'leaked',      0, 1, 1786600000);

INSERT INTO labels (id, user_id, name, color, created_at) VALUES
  ('l_recu', 'dev@localhost', 'Receipts', '#5760bb', 1786100000),
  ('l_impt', 'dev@localhost', 'Important', '#e5544b', 1786100000);

INSERT INTO emails
  (id, alias_id, message_id, from_address, from_name, to_address, subject,
   body_text, snippet, raw_r2_key, html_r2_key, is_read, is_starred,
   is_archived, is_trashed, has_attachments, size_bytes, received_at, blocked_images)
VALUES
  ('e_01','a_bank','<m1@bank.example>','statements@northbank.example','Northbank',
   'bank@example.com','Your September statement is ready',
   'Your monthly statement for account ending 4417 is now available to download.',
   'Your monthly statement for account ending 4417 is now available to download.',
   'a_bank/e_01.eml','a_bank/e_01.html',0,1,0,0,1,184320,1786857000,0),

  ('e_02','a_gh','<m2@github.example>','noreply@github.example','GitHub',
   'github@example.com','[mailriz] PR #16 — Documentation site: Starlight on GitHub Pages',
   'All checks have passed. 3 commits, 31 files changed.',
   'All checks have passed. 3 commits, 31 files changed.',
   'a_gh/e_02.eml','a_gh/e_02.html',0,0,0,0,0,42180,1786853400,0),

  ('e_03','a_netflix','<m3@stream.example>','info@streamly.example','Streamly',
   'netflix@example.com','Your plan renews on 14 September',
   'Your Standard plan renews automatically. No action needed.',
   'Your Standard plan renews automatically. No action needed.',
   'a_netflix/e_03.eml','a_netflix/e_03.html',1,0,0,0,0,96400,1786845000,3),

  ('e_04','a_news','<m4@news.example>','weekly@thefoldletter.example','The Fold',
   'news@example.com','Issue 214 — What self-hosting actually costs',
   'This week: three people who moved off managed services, and what it saved them.',
   'This week: three people who moved off managed services, and what it saved them.',
   'a_news/e_04.eml','a_news/e_04.html',1,0,0,0,0,128900,1786831000,7),

  ('e_05','a_shop','<m5@shop.example>','orders@pinepress.example','Pine Press',
   'toko-sekali@example.com','Order #88213 confirmed',
   'Thanks for your order. Your receipt is attached as a PDF.',
   'Thanks for your order. Your receipt is attached as a PDF.',
   'a_shop/e_05.eml','a_shop/e_05.html',1,0,0,0,1,251000,1786790000,0),

  ('e_06','a_bank','<m6@bank.example>','alerts@northbank.example','Northbank',
   'bank@example.com','Card ending 4417 used at Pine Press',
   'A payment of 41.20 was authorised. If this was not you, contact us.',
   'A payment of 41.20 was authorised. If this was not you, contact us.',
   'a_bank/e_06.eml','a_bank/e_06.html',1,1,0,0,0,31200,1786788000,0),

  ('e_07','a_netflix','<m7@stream.example>','info@streamly.example','Streamly',
   'netflix@example.com','New in your list this week',
   'Six titles were added to your list.',
   'Six titles were added to your list.',
   'a_netflix/e_07.eml','a_netflix/e_07.html',1,0,1,0,0,88000,1786700000,12),

  ('e_08','a_news','<m8@news.example>','weekly@thefoldletter.example','The Fold',
   'news@example.com','Issue 213 — The case against the inbox zero',
   'Why chasing an empty inbox costs more than it returns.',
   'Why chasing an empty inbox costs more than it returns.',
   'a_news/e_08.eml','a_news/e_08.html',1,0,1,0,0,117000,1786610000,4),

  ('e_09','a_gh','<m9@github.example>','noreply@github.example','GitHub',
   'github@example.com','[mailriz] Run failed: CI on docs-site',
   'The job lint-typecheck-test failed after 28s.',
   'The job lint-typecheck-test failed after 28s.',
   'a_gh/e_09.eml','a_gh/e_09.html',1,0,0,1,0,29800,1786520000,0),

  ('e_10','a_spam','<m10@promo.example>','deals@loudmailer.example','Loud Deals',
   'promo2024@example.com','FINAL HOURS — 80% off everything',
   'This offer ends tonight. Unsubscribe at the bottom.',
   'This offer ends tonight. Unsubscribe at the bottom.',
   'a_spam/e_10.eml','a_spam/e_10.html',1,0,0,1,0,64000,1786430000,9);

INSERT INTO email_labels (email_id, label_id) VALUES
  ('e_05','l_recu'), ('e_01','l_recu'), ('e_01','l_impt'), ('e_06','l_impt');

INSERT INTO attachments (id, email_id, filename, content_type, size_bytes, r2_key, content_id) VALUES
  ('at_1','e_01','statement-september.pdf','application/pdf',162000,'a_bank/e_01/statement.pdf',''),
  ('at_2','e_05','receipt-88213.pdf','application/pdf',48200,'a_shop/e_05/receipt.pdf','');
