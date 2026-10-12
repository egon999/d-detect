import os
import win32com.client
from builder_base import DocxWriter, OUTPUT_DIR

def generate_master_doc(word_app):
    w = DocxWriter(
        word_app,
        "D-Detect: Smart Mobile Evidence Vault & Timeline Manager",
        "Master Project Report & System Architecture Specification — Final Year Capstone Project"
    )

    w.add_h1("1. Project Abstract & Executive Summary")
    w.add_p(
        "Project Developer: Diya Jothikumar (Final Year CSE)\n"
        "Support & Developer Email: divv.workkss@gmail.com\n"
        "Target Platform: Android (SDK 24–36, Android 7.0+) and iOS (via Expo Go)\n"
        "Technology Stack: React Native (Expo SDK 55), TypeScript 5.9, Node.js 22, Express/Hono, SQLite (FTS5), Firebase Firestore & Cloud Storage"
    )
    w.add_p(
        "In legal proceedings, workplace disputes, insurance claims, and personal financial tracking, individuals frequently face "
        "evidence disorganization. Receipts fade or get buried in photo galleries, verbal agreements in meetings are forgotten, "
        "critical email dates go missing, and financial transactions lack documented context."
    )
    w.add_p(
        "D-Detect is an offline-first mobile evidence vault and intelligent chronological timeline management system. "
        "It provides individuals with an intuitive, tamper-evident digital repository to securely record, organize, search, "
        "analyze, and export evidentiary records with verifiable chronological provenance."
    )

    w.add_h1("2. Core Functional Highlights")
    w.add_bullet(
        "A date-banded visual feed presenting events, scanned receipts, contracts, voice notes, and meeting records in strict chronological sequence.",
        "Interactive Chronological Timeline:"
    )
    w.add_bullet(
        "Multi-lingual conversational query engine (supporting English, Hindi, and Hinglish) that answers questions grounded strictly in the user's saved records with direct source citations.",
        "Natural Language Query Assistant:"
    )
    w.add_bullet(
        "Interactive bento cards analyzing spending habits, regular recurring bills, cash leaks, and duplicate payments.",
        "Financial Analytics & Budget Forensics:"
    )
    w.add_bullet(
        "Audio recording pipeline with speech-to-text transcription, automated action item extraction, and decision logging.",
        "Meeting Audio Ingestion:"
    )
    w.add_bullet(
        "Custom vector detective character animation featuring realistic eyelid blinking, fedora wobble physics, and micro-interactions.",
        "Modern Visual Polish:"
    )
    w.add_bullet(
        "Full offline access with encrypted local caching, optimistic updates, and background cloud synchronization.",
        "Offline-First Resilience:"
    )
    w.add_bullet(
        "HMAC-SHA256 file integrity sealing, isolated multi-tenant records, and zero data leakage.",
        "Cryptographic Integrity:"
    )

    w.add_h1("3. System Architecture & Component Interaction")
    w.add_p(
        "The D-Detect system architecture is divided into three primary layers: the Mobile Client, the Backend Server, "
        "and the Cloud Infrastructure."
    )
    w.add_table(
        ["Layer", "Technology", "Primary Responsibilities"],
        [
            ["Mobile Frontend", "React Native, Expo SDK 55, TypeScript", "Gesture-driven UI, camera/audio capture, offline caching via AsyncStorage, 60fps animations."],
            ["Backend Engine", "Node.js 22, Hono & Express", "REST API endpoints (/daybook, /ask, /files, /meetings), multi-tenant auth validation, NLP query pipeline."],
            ["Local Database", "SQLite with FTS5 Full-Text Search", "High-speed inverted index text search, transactional storage with Write-Ahead Logging (WAL)."],
            ["Cloud Vault", "Firebase Firestore & Cloud Storage", "Encrypted cloud metadata backup, remote file synchronization, and authentication bridge."],
            ["Testing Suite", "Vitest & Node Test Runner", "1,059 mobile client tests and 606 backend tests verifying math, security, and rendering."]
        ]
    )

    w.add_h1("4. Database Architecture & Multi-Tenancy")
    w.add_p(
        "The backend database utilizes SQLite with Write-Ahead Logging (WAL) mode enabled, delivering exceptional concurrent read/write throughput "
        "without lock contention. To power the natural language query assistant, an SQLite FTS5 (Full-Text Search) virtual table indexes all textual content "
        "from bills, OCR extractions, meeting transcripts, and user notes."
    )
    w.add_callout(
        "Every table in the database includes an 'owner_id' column. Every incoming HTTP request must supply a valid Bearer token. "
        "All database queries strictly enforce 'WHERE owner_id = ?'. This ensures that User A can never search, inspect, or modify "
        "User B's records, providing ironclad multi-tenant data isolation.",
        "MULTI-TENANT SECURITY PRINCIPLE"
    )

    w.add_h1("5. Cryptographic Security & Integrity Seals")
    w.add_p(
        "To ensure that evidence stored within D-Detect is legally admissible and tamper-evident, the server computes an "
        "HMAC-SHA256 cryptographic digest of every incoming file payload at the exact moment of ingestion. "
        "This digital fingerprint is stored immutably alongside the record. If any stored file is modified on disk or tampered with, "
        "its calculated hash will no longer match the stored HMAC seal, instantly alerting the user to file corruption."
    )

    w.add_h1("6. Software Quality & Testing Verification")
    w.add_p(
        "D-Detect has been developed under strict quality assurance standards, achieving 100% test passing rates across both frontend and backend:"
    )
    w.add_bullet("1,059 automated unit and component tests verifying UI rendering, gestures, theme contrast, font scaling, and API client caching.", "Mobile Client Suite (Vitest):")
    w.add_bullet("606 automated tests verifying database migrations, tenant isolation, HMAC seals, FTS5 queries, and anomaly detection algorithms.", "Backend Server Suite (Node Test Runner):")
    w.add_bullet("Total: 1,665 automated tests with 0 failures.", "Overall Verification:")

    w.save_and_close("D-Detect_Master_Project_Documentation.docx")

print("generate_master_doc defined.")
