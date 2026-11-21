-- Default Search Explore (Admin > Default Search, permission "default_search")
-- Safe to run multiple times: only inserts default_search_config if missing.
CREATE TABLE IF NOT EXISTS settings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,
  value       TEXT,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO settings (key, value)
VALUES ('default_search_config', '{"enabled":true,"names":["Abella Danger","Angela White","Mia Malkova","Riley Reid","Lana Rhoades","Eva Elfie","Adriana Chechik","Brandi Love","Mia Khalifa","Cory Chase","Kendra Lust","Sweetie Fox","Alexis Texas","Lisa Ann","Dani Daniels","Asa Akira","Luna Star","Alexis Fawx","Lauren Phillips","Sasha Grey","Sunny Leone","Rae Lil Black","Gina Valentina","Nicole Kitt","Skylar Vox","Autumn Falls","Gabbie Carter","Blake Blossom","Gianna Michaels","Cherie DeVille","Eliza Ibarra","Jia Lissa","Emily Willis","Lena Paul","Madison Ivy","Natasha Nice","Nicole Aniston","Veronica Rodriguez","Sara Jay","Ava Addams","Valentina Nappi","Kelsi Monroe","Little Caprice","Liya Silver","Comatozze","Hazel Moore","Leah Gotti","Elena Koshka","Anissa Kate","Eva Lovia","Darcie Dolce","Kenzie Reeves","Elsa Jean","Violet Myers","Alina Lopez","Sky Bri","Jane Wilde","Aidra Fox","Karlee Grey","Kendra Spade","Rachael Cavalli","Janice Griffith","Tori Black","Remy LaCroix","Naomi Swann","Kayley Gunner","Melody Marks","Stacy Cruz","Sybil A","Nancy Ace","Agatha Vega","Bonnie Rotten","Skin Diamond","Mia Melano","Keisha Grey","Peta Jensen","Kendra Sunderland","August Ames","Haley Reed","Savannah Bond","Kiara Cole","Kyler Quinn","Luna Okko","Christy Mack","Hitomi Tanaka","Anri Okita","Eimi Fukada","Yua Mikami","Ai Uehara","Julia Ann","Phoenix Marie","Bridgette B","Nikki Benz","Sophie Dee","Kagney Linn Karter","Esperanza Gomez","Rebel Lynn","Ariella Ferrera","Romi Rain","Stoya"],"intervalValue":1,"intervalUnit":"days","currentIndex":0,"startedAt":1767225600000}');
