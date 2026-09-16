"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

/** A single-process durable store. Every transaction is serialized and atomically replaced. */
class LocalStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
    this.filename = path.join(this.directory, "database.json");
    this.data = {};
    this.tail = Promise.resolve();
  }
  async open() {
    await fs.mkdir(this.directory, {recursive: true, mode: 0o700});
    try { this.data = JSON.parse(await fs.readFile(this.filename, "utf8")); } catch (error) {
      if (error.code !== "ENOENT") throw new Error("The local database cannot be read. Restore a backup before restarting.");
    }
    return this;
  }
  collection(name) { return new Collection(this, name); }
  async runTransaction(callback) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const next = structuredClone(this.data);
      const transaction = {
        get: async (target) => target.snapshot(next),
        set: (ref, value, options) => { next[ref.collectionName] ||= {}; next[ref.collectionName][ref.id] = options?.merge ? {...next[ref.collectionName][ref.id], ...structuredClone(value)} : structuredClone(value); },
        update: (ref, patch) => {
          if (!next[ref.collectionName]?.[ref.id]) throw new Error("Record no longer exists.");
          next[ref.collectionName][ref.id] = {...next[ref.collectionName][ref.id], ...structuredClone(patch)};
        },
        delete: (ref) => { if (next[ref.collectionName]) delete next[ref.collectionName][ref.id]; },
      };
      const result = await callback(transaction);
      const temporary = `${this.filename}.pending`;
      const file = await fs.open(temporary, "w", 0o600);
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
      await fs.rename(temporary, this.filename);
      this.data = next;
      return result;
    } finally { release(); }
  }
  batch() {
    const operations = [];
    const batch = {set: (...args) => { operations.push(["set", args]); return batch; }, update: (...args) => { operations.push(["update", args]); return batch; }, delete: (...args) => { operations.push(["delete", args]); return batch; }, commit: () => this.runTransaction(async (transaction) => { for (const [kind, args] of operations) transaction[kind](...args); })};
    return batch;
  }
}
class Collection {
  constructor(db, name, conditions = []) { this.db = db; this.collectionName = name; this.conditions = conditions; }
  doc(id) { return new Document(this.db, this.collectionName, id); }
  where(field, operator, value) {
    if (operator !== "==") throw new Error("Unsupported local query.");
    return new Collection(this.db, this.collectionName, [...this.conditions, [field, value]]);
  }
  snapshot(data) {
    return {docs: Object.entries(data[this.collectionName] || {}).filter(([, value]) => this.conditions.every(([field, expected]) => value[field] === expected)).map(([id, value]) => ({id, exists: true, data: () => structuredClone(value)}))};
  }
  async get() { await this.db.tail; return this.snapshot(this.db.data); }
}
class Document {
  constructor(db, name, id) { this.db = db; this.collectionName = name; this.id = id; }
  snapshot(data) { const value = data[this.collectionName]?.[this.id]; return {id: this.id, exists: Boolean(value), data: () => value ? structuredClone(value) : undefined}; }
  async get() { await this.db.tail; return this.snapshot(this.db.data); }
  set(value, options) { return this.db.runTransaction(async (transaction) => transaction.set(this, value, options)); }
  update(patch) { return this.db.runTransaction(async (transaction) => transaction.update(this, patch)); }
}
module.exports = {LocalStore};
