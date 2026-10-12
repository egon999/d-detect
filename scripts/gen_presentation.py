import os
import win32com.client

OUTPUT_DIR = r"C:\Users\ayush\Downloads\D-Detect_Submission_Package"
os.makedirs(OUTPUT_DIR, exist_ok=True)

def generate_presentation():
    ppt = win32com.client.Dispatch("PowerPoint.Application")
    # Don't set ppt.Visible = False as some PowerPoint versions require it or stay minimized
    prs = ppt.Presentations.Add(True)

    slides_data = [
        {
            "title": "D-Detect: Smart Mobile Evidence Vault & Timeline Manager",
            "subtitle": "Final Year Capstone Project Defense | Computer Science & Engineering\nDeveloper: Diya Jothikumar (divv.workkss@gmail.com)\nTarget Platform: Android & iOS",
            "notes": "Good morning respected evaluators. Today I am presenting D-Detect, an intelligent mobile evidence vault and timeline management system."
        },
        {
            "title": "Problem Statement & Real-World Motivation",
            "bullets": [
                "Evidence Scattering: Receipts, contracts, and audio records are buried across photo galleries, chat apps, and voice memos.",
                "Lack of Chronological Context: Difficult to reconstruct exact event timelines during legal disputes or financial audits.",
                "Evidence Tampering Risks: Digital files lack cryptographic seals to prove they have not been edited after the fact.",
                "Inefficient Search: Locating an invoice or verbal agreement from six months ago takes hours of manual digging."
            ],
            "notes": "In legal disputes or rental conflicts, proving what happened and when is the main obstacle. D-Detect solves this by acting as a tamper-evident digital diary."
        },
        {
            "title": "Proposed Solution: D-Detect",
            "bullets": [
                "Consolidated Digital Vault: Combines bills, receipts, contracts, and meeting recordings into one unified app.",
                "Interactive Chronological Timeline: Automatically organizes all records into date-banded visual cards.",
                "Natural Language Assistant: Multi-lingual query engine (English, Hindi, Hinglish) with source-verified citations.",
                "Financial Forensics: Detects recurring expenses, budget anomalies, and duplicate payments automatically.",
                "Cryptographic Integrity: HMAC-SHA256 file fingerprints ensure unalterable proof."
            ],
            "notes": "D-Detect gives users an all-in-one timeline feed, smart conversational search, and automatic financial anomaly alerts."
        },
        {
            "title": "High-Level System Architecture",
            "bullets": [
                "Mobile Client Tier: Built with React Native & Expo SDK 55, delivering 60fps animations and offline caching.",
                "Backend Engine Tier: Node.js 22 with Express/Hono REST APIs managing ingestion, search, and HMAC sealing.",
                "Database Tier: In-process SQLite with Write-Ahead Logging (WAL) and FTS5 inverted search indexing.",
                "Cloud Vault: Firebase Firestore for encrypted metadata sync and Cloud Storage for remote file backup."
            ],
            "notes": "Our 3-tier architecture separates client presentation from backend processing and local database indexing for maximum performance."
        },
        {
            "title": "Key Functional Modules",
            "bullets": [
                "Daybook Timeline: Visual chronological feed organizing events, receipts, and notes by date.",
                "Ask Assistant: Conversational retrieval engine that answers questions grounded strictly in saved evidence.",
                "Money & Bento Analytics: Financial intelligence tracking monthly spending, recurring bill cadence, and duplicate charges.",
                "Meeting Audio Ingestion: Audio recording pipeline that transcribes speech, captures decisions, and creates action tasks."
            ],
            "notes": "Each module serves a distinct real-world role: recording evidence, searching it conversationally, analyzing financial trends, and capturing meetings."
        },
        {
            "title": "Database Design & Multi-Tenant Security",
            "bullets": [
                "Embedded SQLite: In-process database with zero network overhead, capable of 100,000+ reads per second.",
                "FTS5 Virtual Tables: Inverted token indexing enabling sub-second search across thousands of records.",
                "Strict Tenant Isolation: Every query enforces 'WHERE owner_id = ?' via Bearer token validation.",
                "Zero Cross-Tenant Leakage: User A can never view, search, or alter User B's records."
            ],
            "notes": "Multi-tenancy ensures complete privacy. Even on shared databases, every record is isolated by owner identity."
        },
        {
            "title": "AI Grounding (RAG) & Signal Algorithms",
            "bullets": [
                "Retrieval-Augmented Generation (RAG): Natural language assistant queries ground-truth FTS5 records before answering.",
                "Zero Hallucinations: The model is strictly constrained to cite retrieved source IDs and admits when records are absent.",
                "Multi-Lingual Support: Understands natural conversational queries in English, Hindi, and Hinglish.",
                "Signal Detection Algorithms: Automatically flags missing monthly bills and identical payments within short windows."
            ],
            "notes": "By using RAG, we guarantee that the assistant never invents facts—it only quotes real receipts and notes from the user's database."
        },
        {
            "title": "Implementation & Verification Metrics",
            "bullets": [
                "100% TypeScript 5.9: Strict static typing across both client and server eliminates runtime bugs.",
                "Frontend Test Suite: 1,059 Vitest automated tests covering UI rendering, gestures, theme contrast, and offline caching.",
                "Backend Test Suite: 606 Node.js automated tests verifying tenancy, HMAC hashing, FTS5 search, and anomaly detectors.",
                "Overall QA Score: 1,665 total automated tests passing with 0 failures."
            ],
            "notes": "Our comprehensive test coverage of 1,665 passing tests demonstrates engineering rigor and production-grade reliability."
        },
        {
            "title": "Live Application Demonstration Flow",
            "bullets": [
                "Step 1: Sign-In with animated Detective Mascot vector blinking and Google OAuth / Guest authentication.",
                "Step 2: Browse the Daybook Timeline feed with date-banded cards and filter chips.",
                "Step 3: Capture a receipt with instant preview and HMAC-SHA256 cryptographic sealing.",
                "Step 4: Ask conversational questions in the Ask tab with direct receipt proof citations.",
                "Step 5: View spending breakdowns and duplicate bill alerts in the Money tab."
            ],
            "notes": "In our live demo, we showcase the end-to-end workflow from evidence capture to timeline indexing and natural language querying."
        },
        {
            "title": "Conclusion & Future Roadmap",
            "bullets": [
                "Conclusion: Successfully built and verified an offline-first mobile evidence vault with production reliability.",
                "Future Scope 1: Account Aggregator API integration for automated bank and UPI statement ingestion.",
                "Future Scope 2: Blockchain-anchored timestamping on Ethereum/Polygon for verifiable courtroom admissibility.",
                "Future Scope 3: Edge-based on-device OCR and speech recognition models for zero-cloud latency.",
                "Thank You! Questions & Discussion."
            ],
            "notes": "Thank you respected evaluators for your time and feedback. We are now open for your questions and discussion."
        }
    ]

    for idx, slide_info in enumerate(slides_data):
        if idx == 0:
            slide = prs.Slides.Add(1, 1) # Title layout
            slide.Shapes.Title.TextFrame.TextRange.Text = slide_info["title"]
            slide.Shapes.Title.TextFrame.TextRange.Font.Name = "Calibri"
            slide.Shapes.Title.TextFrame.TextRange.Font.Size = 26
            slide.Shapes.Title.TextFrame.TextRange.Font.Bold = True
            slide.Shapes.Title.TextFrame.TextRange.Font.Color.RGB = 0x803010

            sub = slide.Shapes.Placeholders(2)
            sub.TextFrame.TextRange.Text = slide_info["subtitle"]
            sub.TextFrame.TextRange.Font.Name = "Calibri"
            sub.TextFrame.TextRange.Font.Size = 14
            sub.TextFrame.TextRange.Font.Color.RGB = 0x555555
        else:
            slide = prs.Slides.Add(idx + 1, 2) # Bullet layout
            slide.Shapes.Title.TextFrame.TextRange.Text = slide_info["title"]
            slide.Shapes.Title.TextFrame.TextRange.Font.Name = "Calibri"
            slide.Shapes.Title.TextFrame.TextRange.Font.Size = 22
            slide.Shapes.Title.TextFrame.TextRange.Font.Bold = True
            slide.Shapes.Title.TextFrame.TextRange.Font.Color.RGB = 0x803010

            body = slide.Shapes.Placeholders(2)
            tf = body.TextFrame
            tf.TextRange.Text = "\n".join(slide_info["bullets"])
            tf.TextRange.Font.Name = "Calibri"
            tf.TextRange.Font.Size = 13
            tf.TextRange.Font.Color.RGB = 0x222222

        if "notes" in slide_info and slide_info["notes"]:
            slide.NotesPage.Shapes.Placeholders(2).TextFrame.TextRange.Text = slide_info["notes"]

    out_file = os.path.join(OUTPUT_DIR, "D-Detect_Project_Presentation.pptx")
    prs.SaveAs(out_file, 24) # 24 = ppSaveAsOpenXMLPresentation (.pptx)
    prs.Close()
    ppt.Quit()
    print(f"Generated PowerPoint Presentation: {out_file}")

if __name__ == "__main__":
    generate_presentation()
