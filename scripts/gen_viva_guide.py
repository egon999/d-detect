import os
import win32com.client
from builder_base import DocxWriter, OUTPUT_DIR

def generate_viva_guide(word_app):
    w = DocxWriter(
        word_app,
        "D-Detect: Complete College Viva, Defense & Theory Guide",
        "Comprehensive Preparation Material, Technical Concepts & High-Scoring Defense Strategies"
    )

    w.add_h1("1. The Core Theory in Plain English")
    w.add_p(
        "If an examiner asks you to explain the project in one simple sentence:\n"
        "'D-Detect is an offline-first mobile evidence vault that organizes receipts, voice recordings, and important documents into a "
        "cryptographically sealed chronological timeline, allowing users to ask questions in plain English or Hindi to get instant proof.'"
    )
    w.add_p(
        "Why standard tools fail:\n"
        "Google Drive, WhatsApp, and phone galleries store files as disconnected items. They do not correlate related transactions chronologically, "
        "they do not extract OCR text into a unified search index, they cannot detect financial errors like duplicate bill payments, "
        "and they cannot answer questions grounded in your saved receipts."
    )

    w.add_h1("2. Technology Selection Justifications")
    w.add_table(
        ["Framework / Tool", "Why It Was Chosen", "Alternative Considered & Why Rejected"],
        [
            ["React Native (Expo SDK 55)", "Compiles directly to native Android and iOS components with 60fps animations.", "Flutter: Dart is less ubiquitous; React Native shares TypeScript with backend."],
            ["TypeScript 5.9", "Enforces static type safety, eliminating runtime null pointer bugs and interface mismatches.", "Plain JavaScript: Prone to silent runtime errors in complex multi-screen apps."],
            ["Node.js (v22 LTS)", "Asynchronous, event-driven I/O model handles concurrent file uploads and streaming REST calls easily.", "Python/Django: Slower concurrency for high-throughput mobile REST streams."],
            ["SQLite (with FTS5)", "Embedded directly in Node.js process with zero network latency; FTS5 provides sub-second text search.", "MongoDB: Heavy external server requirement; overkill for local mobile vault storage."],
            ["HMAC-SHA256", "Cryptographic hashing standard that creates an unforgeable digital seal for every evidence file.", "Plain MD5 / SHA-1: Vulnerable to collision attacks; HMAC provides keyed authenticity."]
        ]
    )

    w.add_h1("3. Top 22 College Viva Questions & Model Answers")

    questions = [
        ("Q1. What is the core problem that D-Detect solves?",
         "In real-world disputes (such as rental disagreements, workplace investigations, or insurance claims), individuals struggle with disorganized records. D-Detect provides a structured, tamper-evident digital vault that organizes events chronologically and enables fast, verified retrieval."),

        ("Q2. What is an 'Offline-First' architecture and how does D-Detect implement it?",
         "An offline-first architecture ensures that the application functions fully even without an internet connection. D-Detect uses AsyncStorage and local database caching with an optimistic UI pattern. When a user captures a receipt, it is rendered immediately on screen. When connection is restored, background workers sync it with the backend server."),

        ("Q3. What is SQLite FTS5 and why did you use it?",
         "FTS5 stands for Full-Text Search version 5. It is an SQLite virtual table module that creates an inverted index of words across all receipts, OCR text, and meeting transcripts. Unlike standard SQL 'LIKE' queries which scan the entire table, FTS5 finds matches in milliseconds using indexed token lookups."),

        ("Q4. How does the Natural Language Assistant answer questions without 'hallucinating'?",
         "We use Retrieval-Augmented Generation (RAG). When the user asks a question, the server queries the SQLite FTS5 database to retrieve only the user's factual records. These records are passed into the prompt as bounded context. The assistant is instructed to cite only the retrieved record IDs and state 'no records found' if the data is absent."),

        ("Q5. Does the Assistant support regional languages?",
         "Yes, the assistant supports English, Hindi, and Hinglish. It normalizes conversational queries (such as 'pichle mahine ka bijli bill' or 'rent payment status') and returns accurate, cited answers."),

        ("Q6. How is Multi-Tenancy implemented in the database?",
         "Every database table has an 'owner_id' column. The authentication middleware verifies the Bearer token and injects the caller's identity. Every query enforces 'WHERE owner_id = ?', preventing any user from reading or modifying another user's records."),

        ("Q7. How do you prove that an evidence file has not been tampered with?",
         "Upon upload, the backend computes an HMAC-SHA256 cryptographic digest using a secret key. This hash fingerprint is stored permanently. If the file is altered by even one byte, the hash changes, invalidating the seal and alerting the user."),

        ("Q8. What is the role of Write-Ahead Logging (WAL) in SQLite?",
         "WAL mode allows concurrent reads and writes. Readers do not block writers, and writers do not block readers. This significantly improves performance during simultaneous file uploads and search queries."),

        ("Q9. How does meeting audio processing work in D-Detect?",
         "The user records audio through the mobile app. The audio is uploaded to the backend where a transcription pipeline converts speech to text, extracts key decisions, and automatically generates checklist action items in the Tasks tab."),

        ("Q10. How does the Financial Forensics feature detect anomalies?",
         "Heuristic signal algorithms inspect transaction histories. They detect missing payments in regular monthly cadences (e.g., missed rent or subscription) and flag duplicate payments made to the same payee within a narrow time window."),

        ("Q11. What is Expo Router and why is it preferred over traditional React Navigation?",
         "Expo Router uses file-based routing (similar to Next.js). The folder structure in 'app/' automatically defines the navigation stack and tab bars, reducing boilerplate code and making deep linking effortless."),

        ("Q12. What is the purpose of Cloudflare Tunnel in this project?",
         "The backend runs on 'localhost:8787' on the PC. Cloudflare Tunnel creates a secure public HTTPS URL ('https://...trycloudflare.com') that allows the mobile phone to access the PC's backend across any network without complex router port forwarding or firewall configuration."),

        ("Q13. How does the app handle errors without showing technical stack traces to users?",
         "All error handlers wrap exceptions in human-friendly sentences (e.g. 'This copy could not be read clearly, please try again') while logging sanitized diagnostic details internally. Internal paths, server ports, and vendor names are never leaked."),

        ("Q14. How many automated tests exist in the project, and what do they verify?",
         "There are 1,665 total automated tests: 1,059 frontend tests running on Vitest (testing UI components, theme contrast, font scaling, offline caching) and 606 backend tests running on Node Test Runner (testing tenancy, database schemas, HMAC seals, and anomaly detectors). All 1,665 tests pass with 0 failures."),

        ("Q15. Why did you choose SQLite over MongoDB or MySQL?",
         "SQLite is embedded directly into the Node.js process, which eliminates external database network roundtrips. For an edge-focused, single-node application with FTS5 search requirements, SQLite is faster, simpler to maintain, and requires zero separate database server configuration."),

        ("Q16. What happens if the server crashes while writing a record?",
         "Because SQLite uses atomic ACID transactions and WAL journaling, any interrupted write is rolled back automatically upon recovery, preventing database corruption."),

        ("Q17. What security measures protect user authentication on the mobile device?",
         "Tokens and sensitive user preferences are stored using 'expo-secure-store', which uses the Android Keystore system and iOS Keychain to encrypt data using hardware-backed cryptographic modules."),

        ("Q18. How does the custom Detective mascot animation work?",
         "The Detective Mascot is built with pure React Native vector components and animated using Animated timing loops. It features 60fps physics, eyelid blinking, fedora tilt wobble, and interactive feedback."),

        ("Q19. What is the difference between an APK and an AAB?",
         "An APK (Android Package Kit) is the ready-to-install package that can be sideloaded directly on any Android handset. An AAB (Android App Bundle) is the publishing format uploaded to the Google Play Store, which Google splits into device-specific APKs."),

        ("Q20. Can this app be deployed to a cloud server like AWS or Render?",
         "Yes! The Node.js server is completely containerizable with Docker and can be deployed to AWS EC2, Render, Railway, or Google Cloud Run by setting standard environment variables."),

        ("Q21. What are the current limitations of the project?",
         "OCR processing of very large PDF files (50+ pages) requires significant CPU resources, and audio transcription of noisy environments requires clear microphone input."),

        ("Q22. What are the planned future enhancements?",
         "Direct integration with India's Account Aggregator framework for automated UPI bank statement ingestion, and blockchain-anchored timestamping on Ethereum or Polygon for verifiable courtroom proof.")
    ]

    for q, a in questions:
        w.add_h2(q)
        w.add_p(a)

    w.add_h1("4. Examiner 'Trap Questions' & Smart Responses")
    w.add_callout(
        "Examiner: 'Isn't SQLite too weak for a production application?'\n\n"
        "Your Answer: 'Actually, respected professor, SQLite is used in production by Airbus, Apple, and browsers like Google Chrome. "
        "With Write-Ahead Logging (WAL) mode enabled, SQLite can process over 100,000 reads per second. Because our backend runs the database "
        "in-process, it completely eliminates network overhead, making it faster than external database servers for our evidence vault architecture.'",
        "TRAP QUESTION 1"
    )
    w.add_callout(
        "Examiner: 'Can the AI assistant invent fake evidence or hallucinate answers?'\n\n"
        "Your Answer: 'No, because we implement strict Retrieval-Augmented Generation (RAG). The assistant never answers from its general knowledge. "
        "It only synthesizes answers from verified records retrieved by the SQLite FTS5 engine, and it is strictly constrained to include direct "
        "record citations. If no records match the query, it explicitly states that no matching evidence was found.'",
        "TRAP QUESTION 2"
    )

    w.save_and_close("D-Detect_College_Viva_and_Theory_Guide.docx")

print("generate_viva_guide defined.")
