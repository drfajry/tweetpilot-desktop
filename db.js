// محرك تخزين JSON بسيط — بديل better-sqlite3 بدون أي compilation
const fs = require('fs');
const path = require('path');

class JsonDB {
  constructor(dbPath) {
    this.file = dbPath.replace(/\.db$/, '.json');
    this.data = {
      auth: [],
      tweet_history: [],
      scheduled_tweets: [],
    };
    this.counters = { tweet_history: 0, scheduled_tweets: 0 };
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = raw.data || this.data;
        this.counters = raw.counters || this.counters;
      }
    } catch(e) { /* ابدأ فارغاً */ }
  }

  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ data: this.data, counters: this.counters }));
    } catch(e) {}
  }

  // واجهة متوافقة مع better-sqlite3
  prepare(sql) {
    return new Statement(this, sql);
  }

  exec() { /* الجداول تُنشأ تلقائياً */ }
  pragma() {}
}

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.trim();
  }

  run(...params) {
    const sql = this.sql;

    // INSERT auth (id ثابت في SQL: VALUES (1,...) أو VALUES (2,...))
    if (/INSERT OR REPLACE INTO auth/i.test(sql)) {
      const idMatch = sql.match(/VALUES\s*\(\s*(\d+)/i);
      const id = idMatch ? parseInt(idMatch[1]) : 1;
      const [username, name, profile_image] = params;
      this.db.data.auth = this.db.data.auth.filter(r => r.id !== id);
      this.db.data.auth.push({ id, username, name, profile_image });
      this.db._save();
      return { lastInsertRowid: id };
    }

    // INSERT tweet_history
    if (/INSERT INTO tweet_history/i.test(sql)) {
      const [content, tweet_id, status] = params;
      const id = ++this.db.counters.tweet_history;
      this.db.data.tweet_history.push({ id, content, tweet_id, status, posted_at: new Date().toISOString() });
      this.db._save();
      return { lastInsertRowid: id };
    }

    // INSERT scheduled_tweets
    if (/INSERT INTO scheduled_tweets/i.test(sql)) {
      const [content, scheduled_at] = params;
      const id = ++this.db.counters.scheduled_tweets;
      this.db.data.scheduled_tweets.push({ id, content, scheduled_at, status: 'pending', tweet_id: null, error: null });
      this.db._save();
      return { lastInsertRowid: id };
    }

    // UPDATE scheduled_tweets ... posted
    if (/UPDATE scheduled_tweets SET status="posted"/i.test(sql)) {
      const [tweet_id, id] = params;
      const row = this.db.data.scheduled_tweets.find(r => r.id === id);
      if (row) { row.status = 'posted'; row.tweet_id = tweet_id; }
      this.db._save();
      return {};
    }

    // UPDATE scheduled_tweets ... failed
    if (/UPDATE scheduled_tweets SET status="failed"/i.test(sql)) {
      const [error, id] = params;
      const row = this.db.data.scheduled_tweets.find(r => r.id === id);
      if (row) { row.status = 'failed'; row.error = error; }
      this.db._save();
      return {};
    }

    // DELETE scheduled by id
    if (/DELETE FROM scheduled_tweets WHERE id=/i.test(sql)) {
      const [id] = params;
      this.db.data.scheduled_tweets = this.db.data.scheduled_tweets.filter(r => r.id !== id);
      this.db._save();
      return {};
    }

    // DELETE all pending
    if (/DELETE FROM scheduled_tweets WHERE status='pending'/i.test(sql)) {
      this.db.data.scheduled_tweets = this.db.data.scheduled_tweets.filter(r => r.status !== 'pending');
      this.db._save();
      return {};
    }

    // DELETE auth
    if (/DELETE FROM auth/i.test(sql)) {
      const id = sql.includes('id=1') ? 1 : (sql.includes('id=2') ? 2 : null);
      if (id) this.db.data.auth = this.db.data.auth.filter(r => r.id !== id);
      else this.db.data.auth = [];
      this.db._save();
      return {};
    }

    return {};
  }

  get(...params) {
    const sql = this.sql;

    // SELECT auth WHERE id=1 أو id=2
    if (/SELECT \* FROM auth WHERE id=/i.test(sql)) {
      const id = sql.includes('id=2') ? 2 : 1;
      return this.db.data.auth.find(r => r.id === id) || undefined;
    }

    return undefined;
  }

  all(...params) {
    const sql = this.sql;

    // scheduled_tweets ORDER BY scheduled_at ASC
    if (/SELECT \* FROM scheduled_tweets ORDER BY scheduled_at ASC/i.test(sql)) {
      return [...this.db.data.scheduled_tweets]
        .sort((a,b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))
        .slice(0, 100);
    }

    // pending scheduled <= now
    if (/SELECT \* FROM scheduled_tweets WHERE status="pending" AND scheduled_at <=/i.test(sql)) {
      const now = params[0];
      return this.db.data.scheduled_tweets.filter(r =>
        r.status === 'pending' && new Date(r.scheduled_at) <= new Date(now)
      );
    }

    // tweet_history ORDER BY posted_at DESC
    if (/SELECT \* FROM tweet_history ORDER BY posted_at DESC/i.test(sql)) {
      return [...this.db.data.tweet_history]
        .sort((a,b) => new Date(b.posted_at) - new Date(a.posted_at))
        .slice(0, 50);
    }

    return [];
  }
}

module.exports = JsonDB;
