# D-Detect: Smart Mobile Evidence Vault & Timeline Manager

**Author & Developer**: Diya Jothikumar  
**Support & Developer Contact**: divv.workkss@gmail.com  
**Project Classification**: Advanced Final Year Engineering Capstone Project  
**Target Platform**: Android (Minimum SDK 24, Target SDK 36, Android 7.0 to 15+)  
**Technology Stack**: React Native (Expo SDK 55), TypeScript, Node.js (v22), Express, SQLite (FTS5), Firebase Firestore & Cloud Storage  

---

## 1. Executive Summary & Problem Solved

In real-world legal proceedings, workplace disputes, insurance claims, and personal financial tracking, individuals frequently face evidence disorganization. Receipts fade or get buried in phone galleries, verbal agreements in meetings are forgotten, critical email dates go missing, and financial transactions lack documented context.

**D-Detect** is a full-stack, offline-first mobile evidence vault and intelligent chronological timeline management system. It provides individuals with an intuitive, tamper-evident digital repository to securely record, organize, search, analyze, and export evidentiary records with verifiable chronological provenance.

### Core Capabilities:
- **Chronological Daybook Timeline**: High-performance, date-banded visual feed presenting events, scanned receipts, contracts, voice notes, and meeting records.
- **Natural Language Assistant**: Multi-lingual conversational retrieval engine supporting English, Hindi, and Hinglish. Answers user queries grounded strictly in saved records with verified citations.
- **Financial Analytics & Budget Forensics**: Interactive bento breakdown categorizing spending habits, recurring bill cadence, cash leaks, and duplicate payments.
- **Meeting Audio Processing**: Audio transcription pipeline with automatic task generation and actionable decision logging.
- **Offline-First Resilience**: Local caching via AsyncStorage and SQLite with automatic background synchronization upon network reconnection.
- **Enterprise-Grade Security**: HMAC-SHA256 file integrity sealing, isolated multi-tenant records, and zero data leakage.

---

## 2. Quick Start Guide

### Prerequisites
- Node.js (v20.x or v22.x LTS recommended)
- npm or yarn package manager
- Android Studio / Android Handset (for running the mobile client)

### Running the Backend Server
```bash
# Navigate to the backend directory
cd server

# Install dependencies (if not already installed)
npm install

# Start the server (runs on port 8787 by default)
npm start
```

### Running the Mobile Client
```bash
# In the detact directory
npm install

# Start the Expo development server
npx expo start
```
Scan the QR code using the Expo Go application on your Android phone, or run directly on a connected device with `npx expo run:android`.

### Production APK Installation
A pre-built, signed production APK is included in the project root:
- Location: `detact-release.apk`
- Minimum Android Version: Android 7.0 (Nougat, API Level 24)
- Target Android Version: Android 15 (Vanilla Ice Cream, API Level 36)

---

## 3. Key Technical Specifications

| Component | Technology | Role |
| :--- | :--- | :--- |
| **Mobile Client** | React Native / Expo SDK 55 | Cross-platform native UI with 60fps animations |
| **Type Safety** | TypeScript 5.9 | Strict end-to-end typing across client and server |
| **Backend Engine** | Node.js 22 & Hono / Express | High-throughput asynchronous REST API |
| **Local Database** | SQLite with FTS5 Full-Text Search | Fast on-device indexing, querying, and search |
| **Cloud Vault** | Firebase Firestore & Cloud Storage | Secure remote backup, authentication, and file sync |
| **Testing** | Vitest & Node Test Runner | 1,059 mobile client tests and 606 server tests |

---

## 4. Documentation Links

For comprehensive technical insights and client presentation preparation, refer to:
- [ARCHITECTURE.md](file:///E:/Project%20Evid/detact/ARCHITECTURE.md) - System architecture, data flow, security model, and API contracts.
- [CODEBASE_GUIDE.md](file:///E:/Project%20Evid/detact/CODEBASE_GUIDE.md) - Directory layout, file-by-file module walkthrough, and feature implementations.
