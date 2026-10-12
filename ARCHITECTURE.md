# D-Detect: Architectural Design & System Engineering

This document details the architectural blueprints, communication flows, database design, and cryptographic security principles underlying **D-Detect**.

---

## 1. High-Level Architectural Diagram

```
+-----------------------------------------------------------------------------------+
|                            MOBILE CLIENT (REACT NATIVE)                           |
|                                                                                   |
|   +--------------------+   +-----------------------+   +----------------------+   |
|   |  Activity Timeline |   |  Query Assistant      |   | Financial Bento      |   |
|   |  (Daybook Feed)    |   |  (Natural Language)   |   | (Analytics Engine)   |   |
|   +---------+----------+   +-----------+-----------+   +----------+-----------+   |
|             |                          |                          |               |
|             +--------------------------+--------------------------+               |
|                                        |                                          |
|                         +--------------v--------------+                           |
|                         |  Client State & Cache Layer |                           |
|                         |  (AsyncStorage / In-Memory) |                           |
|                         +--------------+--------------+                           |
+----------------------------------------|------------------------------------------+
                                         | HTTPS / TLS 1.3
                                         v
+-----------------------------------------------------------------------------------+
|                            BACKEND SERVER (NODE.JS)                               |
|                                                                                   |
|   +-------------------+    +----------------------+    +----------------------+   |
|   | /daybook Routes   |    | /ask Query Routes    |    | /files Routes        |   |
|   | Timeline Records  |    | Context Grounding    |    | HMAC Integrity Seal  |   |
|   +---------+---------+    +-----------+----------+    +----------+-----------+   |
|             |                          |                          |               |
|             +--------------------------+--------------------------+               |
|                                        |                                          |
|                         +--------------v--------------+                           |
|                         |  SQLite Engine (FTS5 Search)|                           |
|                         |  Strict Tenant Isolation    |                           |
|                         +--------------+--------------+                           |
+----------------------------------------|------------------------------------------+
                                         | Secure Remote Sync
                                         v
+-----------------------------------------------------------------------------------+
|                        CLOUD INFRASTRUCTURE (FIREBASE)                            |
|                                                                                   |
|        +-----------------------------+     +-----------------------------+        |
|        |      Firebase Firestore     |     |    Firebase Cloud Storage   |        |
|        |     (Encrypted Metadata)    |     |      (Encrypted Blobs)      |        |
|        +-----------------------------+     +-----------------------------+        |
+-----------------------------------------------------------------------------------+
```

---

## 2. Frontend-Backend Interaction Flow

### A. Record Capture & Storage Pipeline
1. **User Action**: The user snaps a receipt image, enters a note, or records audio in `app/capture.tsx` or `app/record/`.
2. **Local Caching (Optimistic UI)**: The record is immediately rendered in the UI with a pending state so the user experiences zero lag.
3. **Network Transport**: The client initiates a `POST /daybook` or `POST /files` request carrying the binary payload and metadata with an authenticated Bearer token.
4. **Server Validation**: The server verifies authentication, computes an HMAC-SHA256 checksum of the incoming file to verify integrity, and stores the record in SQLite.
5. **Background Cloud Backup**: Metadata is replicated to Firebase Firestore, and raw files are streamed to Firebase Cloud Storage.

### B. Natural Language Query Assistant Flow
1. **User Query**: The user asks a question in `app/ask.tsx` (e.g., *"How much did I pay for electricity last month?"*).
2. **Full-Text Retrieval**: The server executes an SQLite FTS5 query matching keywords across the user's private records.
3. **Context Construction & Grounding**: The matched records are assembled into a verified context window. Instructions strictly enforce that the model cannot fabricate citations.
4. **Response Delivery**: The server returns a synthesized natural language answer paired with exact record IDs (`sourceIds`) as verifiable citations.

---

## 3. Database Architecture & Multi-Tenancy

### SQLite Architecture
- **Primary Database**: `detact.db` with Write-Ahead Logging (`WAL` mode) enabled for non-blocking concurrent reads and writes.
- **FTS5 Virtual Tables**: Virtual tables indexed for fast full-text searching across titles, OCR text, notes, and transcripts.
- **Tenant Isolation**: Every database table enforces an `owner_id` column. Queries strictly filter by `owner_id = ?`, ensuring complete data isolation between accounts.

---

## 4. Cryptographic Security Model

1. **HMAC-SHA256 File Seals**: Every uploaded evidence file is cryptographically sealed using HMAC-SHA256. Any modification to a stored file invalidates the seal.
2. **Secure Key Vaulting**: Credentials and authentication tokens on Android are stored using hardware-backed keystores via `expo-secure-store`.
3. **No Machine Data Leakage**: Error handling shields server internals; stack traces, internal paths, and third-party provider names are strictly stripped from responses.
