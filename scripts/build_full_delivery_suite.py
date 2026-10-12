import os
import sys
import win32com.client
import shutil
from gen_handover import generate_handover_guide
from gen_master_doc import generate_master_doc
from gen_viva_guide import generate_viva_guide
from gen_dev_cheatsheet import generate_dev_cheatsheet
from gen_presentation import generate_presentation
from gen_html_and_zip import generate_clean_zip, clean_old_markdown_files, OUTPUT_DIR, HTML_STYLE

def generate_html_files():
    # 1. Handover Guide HTML
    handover_html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>D-Detect: iOS & Mobile Handover Guide</title>
  {HTML_STYLE}
</head>
<body>
<div class="container">
  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <h1>D-Detect: Complete Mobile & iOS Handover Guide</h1>
  <div class="subtitle">Step-by-Step Clean Laptop Setup, Cloudflare Tunnel Networking, and Client Communication</div>

  <h2>1. Executive Handover Summary</h2>
  <p>This handover package contains everything required to transfer the complete D-Detect project to your client today. The application has been finalized, thoroughly optimized, and mathematically verified through 1,665 automated tests. Because your client has a clean laptop and no prior technical background, this guide is written in plain, friendly English so that she can understand, install, run, and present the project with total confidence.</p>
  <ul>
    <li><strong>Deliverable 1:</strong> Complete source code archive (lightweight ZIP, clean of heavy caches).</li>
    <li><strong>Deliverable 2:</strong> Pre-built signed Android release APK (detact-release.apk) ready for direct phone installation.</li>
    <li><strong>Deliverable 3:</strong> Private GitHub repository access (<a href="https://github.com/egon999/d-detect">https://github.com/egon999/d-detect</a>) for formal university code submission.</li>
    <li><strong>Deliverable 4:</strong> Executive project documentation in Microsoft Word (.docx) and Web format (.html).</li>
    <li><strong>Deliverable 5:</strong> Comprehensive College Viva & Defense Preparation Guide with 22+ questions and model answers.</li>
    <li><strong>Deliverable 6:</strong> 10-Slide Microsoft PowerPoint presentation (.pptx) with complete speaker talking points.</li>
    <li><strong>Deliverable 7:</strong> Step-by-step remote live demonstration script and emergency troubleshooting cheat sheet.</li>
  </ul>

  <h2>2. Ready-to-Send Client Message (Ready to Copy & Paste)</h2>
  <p>Copy and send this message directly to your client via WhatsApp or Email. It sets a warm, professional, and reassuring tone while outlining exactly what she is receiving and how the live demo will work:</p>
  <pre>Hi! I'm happy to let you know that the D-Detect project is completely finished, fully tested, and ready for you!

Here is what I have prepared for you today:
1. Complete Source Code: A clean, easy-to-extract ZIP file containing the entire frontend and backend code.
2. Ready-to-Install Android App: A production-ready .apk file that you can install directly on any Android phone.
3. Mobile & iOS Access: Complete instructions to run the application live on your iPhone or Android using Expo Go.
4. Project Documentation & College Presentation: Beautiful Word documents and PowerPoint presentation slides explaining how the app works, its architecture, and its features.
5. College Viva Preparation Kit: A detailed question-and-answer guide with 20+ likely questions your professors might ask, along with simple, confident answers.

How our demonstration will work:
We'll hop on a quick call where I will show you the application running live on mobile, walk you through the key features (the chronological timeline, the smart query assistant, and the financial forensics), and help you set it up on your laptop step by step. You don't need any prior coding knowledge at all—I'll guide you through every click!

Let me know when you're free today for our handover call!</pre>

  <h2>3. The Best & Easiest Way to Deliver Source Files</h2>
  <p>When handing over a software project to a non-technical client, choosing the right file delivery channel is critical to prevent frustration:</p>
  <ul>
    <li><strong>Primary Recommendation (Clean ZIP Archive):</strong> Delivering the pre-packaged <code>D-Detect_Complete_Project_Source.zip</code> archive via Google Drive, OneDrive, or a USB flash drive is the absolute best method. It requires zero command-line tools, no Git installation, and no SSH key configuration. She can simply right-click and 'Extract All' to any folder on her PC.</li>
    <li><strong>Secondary Option (Private GitHub Repository):</strong> If her college or institute explicitly requires a private GitHub repository URL to prove version control and commit history, you can invite her GitHub username as a collaborator to <code>https://github.com/egon999/d-detect</code>. However, for running the project on her laptop, always have her use the ZIP file to avoid Git authentication issues.</li>
  </ul>

  <h2>4. Running on PC & Accessing on Mobile (Cloudflare Tunnel Guide)</h2>
  <p>During development, we ran the backend server on a PC and used Cloudflare Tunnel to connect the mobile phone. Here is the simple explanation of why this was done, and why it remains the best approach:</p>
  
  <h3>Why Do We Need a Tunnel?</h3>
  <p>The D-Detect backend (which manages the database, search indexing, and cryptographic file sealing) runs locally on the laptop at <code>http://localhost:8787</code>. A phone (iPhone or Android) cannot access 'localhost' on a computer because 'localhost' means 'this device itself'. To allow the phone to communicate with the laptop's backend, the laptop must expose a secure network address that the phone can reach.</p>

  <h3>Is Cloudflare Tunnel Still the Best Approach?</h3>
  <p>Yes, Cloudflare Tunnel is by far the most reliable, professional, and foolproof method for college demonstrations and mobile access. Here is why comparing the 3 possible methods:</p>
  <ul>
    <li><strong>Method A: Cloudflare Tunnel (Recommended):</strong> Cloudflare Tunnel gives you a free, public, encrypted HTTPS URL (e.g. <code>https://example.trycloudflare.com</code>). Because it is a public HTTPS URL, it works across ANY network—including college Wi-Fi, home Wi-Fi, and cellular mobile data (4G/5G). Most importantly, college and hostel Wi-Fi networks block local device-to-device communication (a security feature called 'Client/AP Isolation'). Cloudflare Tunnel bypasses this completely because the connection routes through Cloudflare's global edge network.</li>
    <li><strong>Method B: Local Wi-Fi IP (Unreliable on College Networks):</strong> Connecting over the local Wi-Fi IP address (e.g. <code>http://192.168.1.5:8787</code>) works at home if both devices are on the same router. However, it almost ALWAYS FAILS in college auditoriums and computer labs because college networks block local peer communication. Furthermore, iOS blocks plain HTTP requests for security.</li>
    <li><strong>Method C: Expo Tunnel Mode (Best for Mobile Frontend):</strong> When running the frontend with <code>npx expo start --tunnel</code>, Expo creates its own tunnel for streaming the React Native JavaScript app into the Expo Go mobile app on your iPhone or Android. This works seamlessly alongside Cloudflare Tunnel.</li>
  </ul>

  <h2>5. Beginner's Step-by-Step Setup Guide (Clean Laptop)</h2>
  
  <h3>Step 1: Install Node.js (Runtime Environment)</h3>
  <ul>
    <li><strong>Download Link:</strong> Go to <a href="https://nodejs.org">https://nodejs.org</a> in Chrome or Edge.</li>
    <li><strong>Which Version:</strong> Click the big green button that says 'LTS - Recommended for Most Users' (Version 20 or 22).</li>
    <li><strong>Installation:</strong> Open the downloaded .msi file. Click 'Next', accept the license agreement, keep all default options selected (make sure 'Add to PATH' is checked), and click 'Install'.</li>
    <li><strong>Verification:</strong> Open Command Prompt (press Windows Key, type 'cmd', press Enter). Type <code>node -v</code> and press Enter. If it displays a version like 'v22.x.x', Node.js is ready!</li>
  </ul>

  <h3>Step 2: Install Cloudflared (Cloudflare Tunnel)</h3>
  <ul>
    <li><strong>Download Link:</strong> Download the official Windows installer directly from: <a href="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi">https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi</a></li>
    <li><strong>Installation:</strong> Double-click the installer and follow the quick setup wizard.</li>
    <li><strong>Verification:</strong> Open Command Prompt, type <code>cloudflared --version</code>, and press Enter. You should see 'cloudflared version 2026.x.x'.</li>
  </ul>

  <h3>Step 3: Install Expo Go on the Mobile Phone</h3>
  <ul>
    <li><strong>For iPhone (iOS):</strong> Open the Apple App Store, search for 'Expo Go', and tap 'Get' to install.</li>
    <li><strong>For Android:</strong> Open the Google Play Store, search for 'Expo Go', and install it. Alternatively, install the pre-built 'detact-release.apk' included in the project folder.</li>
  </ul>

  <h3>Step 4: Extract the Project Files</h3>
  <p>Take the <code>D-Detect_Complete_Project_Source.zip</code> file, right-click it, select 'Extract All...', and choose a clean folder such as <code>C:\\Projects\\detact</code> or your Desktop.</p>

  <h3>Step 5: Start the Backend Server</h3>
  <p>1. Open Command Prompt.<br>
  2. Navigate to the server folder by typing:<br>
  <code>cd C:\\Projects\\detact\\server</code><br>
  3. (First time only) Install packages by typing:<br>
  <code>npm install</code><br>
  4. Start the server by typing:<br>
  <code>npm start</code><br>
  You will see: 'Detact backend listening on port 8787'.</p>

  <h3>Step 6: Start Cloudflare Tunnel</h3>
  <p>1. Open a SECOND Command Prompt window (keep the first one running!).<br>
  2. Type the following command and press Enter:<br>
  <code>cloudflared tunnel --url http://localhost:8787</code><br>
  3. Within 5 seconds, Cloudflare will print log messages. Look for a line containing a public HTTPS URL such as:<br>
  <code>https://your-unique-subdomain.trycloudflare.com</code><br>
  This is the secure public link to your backend server!</p>

  <h3>Step 7: Launch the Mobile App Bundler</h3>
  <p>1. Open a THIRD Command Prompt window.<br>
  2. Navigate to the main project folder by typing:<br>
  <code>cd C:\\Projects\\detact</code><br>
  3. (First time only) Install packages by typing:<br>
  <code>npm install</code><br>
  4. Start the Expo bundler in tunnel mode by typing:<br>
  <code>npx expo start --tunnel</code><br>
  5. A large QR code will appear directly in your terminal window.</p>

  <h3>Step 8: Open and Run on Your Mobile Phone</h3>
  <ul>
    <li><strong>On iPhone (iOS):</strong> Open the default Camera app on your iPhone, point the camera at the terminal QR code, and tap the yellow 'Open in Expo Go' popup. Expo Go will launch, download the JavaScript bundle, and display the D-Detect app natively on your iPhone!</li>
    <li><strong>On Android:</strong> Open the Expo Go app, tap 'Scan QR code', and scan the terminal QR code. The app will launch immediately.</li>
  </ul>

  <h2>6. Troubleshooting & Common Questions</h2>
  <table>
    <tr>
      <th>Symptom / Error</th>
      <th>Root Cause</th>
      <th>Simple Fix</th>
    </tr>
    <tr>
      <td>'node' or 'npm' is not recognized</td>
      <td>Command prompt was open during installation</td>
      <td>Close all command prompt windows and open a fresh one.</td>
    </tr>
    <tr>
      <td>Port 8787 already in use</td>
      <td>Another server instance is running in background</td>
      <td>Run 'npx kill-port 8787' or restart the laptop.</td>
    </tr>
    <tr>
      <td>Cloudflare tunnel drops or disconnects</td>
      <td>Temporary Wi-Fi interruption</td>
      <td>Press Ctrl+C in the tunnel window and re-run the command.</td>
    </tr>
    <tr>
      <td>Expo says 'Network response timed out'</td>
      <td>Laptop and phone cannot reach each other</td>
      <td>Always use 'npx expo start --tunnel' rather than standard LAN mode.</td>
    </tr>
    <tr>
      <td>Camera doesn't detect QR code on iPhone</td>
      <td>Screen glare or terminal font too small</td>
      <td>Maximize the Command Prompt window so the QR code is clearly visible.</td>
    </tr>
  </table>
</div>
</body>
</html>"""
    with open(os.path.join(OUTPUT_DIR, "D-Detect_iOS_and_Mobile_Handover_Guide.html"), "w", encoding="utf-8") as f:
        f.write(handover_html)

    # 2. Viva Guide HTML
    viva_html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>D-Detect: College Viva & Theory Guide</title>
  {HTML_STYLE}
</head>
<body>
<div class="container">
  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <h1>D-Detect: Complete College Viva, Defense & Theory Guide</h1>
  <div class="subtitle">Comprehensive Preparation Material, Technical Concepts & High-Scoring Defense Strategies</div>

  <h2>1. The Core Theory in Plain English</h2>
  <div class="callout">
    <div class="callout-title">30-SECOND ELEVATOR PITCH FOR EXAMINERS:</div>
    "D-Detect is an offline-first mobile evidence vault that organizes receipts, voice recordings, and important documents into a cryptographically sealed chronological timeline, allowing users to ask questions in plain English or Hindi to get instant proof."
  </div>

  <h2>2. Technology Selection Justifications</h2>
  <table>
    <tr>
      <th>Framework / Tool</th>
      <th>Why It Was Chosen</th>
      <th>Alternative Considered & Why Rejected</th>
    </tr>
    <tr>
      <td>React Native (Expo SDK 55)</td>
      <td>Compiles directly to native Android and iOS components with 60fps animations.</td>
      <td>Flutter: Dart is less ubiquitous; React Native shares TypeScript with backend.</td>
    </tr>
    <tr>
      <td>TypeScript 5.9</td>
      <td>Enforces static type safety, eliminating runtime null pointer bugs and interface mismatches.</td>
      <td>Plain JavaScript: Prone to silent runtime errors in complex multi-screen apps.</td>
    </tr>
    <tr>
      <td>Node.js (v22 LTS)</td>
      <td>Asynchronous, event-driven I/O model handles concurrent file uploads and streaming REST calls easily.</td>
      <td>Python/Django: Slower concurrency for high-throughput mobile REST streams.</td>
    </tr>
    <tr>
      <td>SQLite (with FTS5)</td>
      <td>Embedded directly in Node.js process with zero network latency; FTS5 provides sub-second text search.</td>
      <td>MongoDB: Heavy external server requirement; overkill for local mobile vault storage.</td>
    </tr>
    <tr>
      <td>HMAC-SHA256</td>
      <td>Cryptographic hashing standard that creates an unforgeable digital seal for every evidence file.</td>
      <td>Plain MD5 / SHA-1: Vulnerable to collision attacks; HMAC provides keyed authenticity.</td>
    </tr>
  </table>

  <h2>3. Key Viva Questions & Answers (Sample)</h2>
  <h3>Q1. How does the Natural Language Assistant answer questions without 'hallucinating'?</h3>
  <p>We use Retrieval-Augmented Generation (RAG). When the user asks a question, the server queries the SQLite FTS5 database to retrieve only the user's factual records. These records are passed into the prompt as bounded context. The assistant is instructed to cite only the retrieved record IDs and state 'no records found' if the data is absent.</p>

  <h3>Q2. How is Multi-Tenancy implemented in the database?</h3>
  <p>Every database table has an 'owner_id' column. The authentication middleware verifies the Bearer token and injects the caller's identity. Every query enforces <code>WHERE owner_id = ?</code>, preventing any user from reading or modifying another user's records.</p>

  <h3>Q3. How do you prove that an evidence file has not been tampered with?</h3>
  <p>Upon upload, the backend computes an HMAC-SHA256 cryptographic digest using a secret key. This hash fingerprint is stored permanently. If the file is altered by even one byte, the hash changes, invalidating the seal and alerting the user.</p>

  <div class="callout">
    <div class="callout-title">EXAMINER TRAP QUESTION: "Isn't SQLite too weak for production?"</div>
    "Actually, respected professor, SQLite is used in production by Airbus, Apple, and browsers like Google Chrome. With Write-Ahead Logging (WAL) mode enabled, SQLite can process over 100,000 reads per second. Because our backend runs the database in-process, it completely eliminates network overhead, making it faster than external database servers for our evidence vault architecture."
  </div>
</div>
</body>
</html>"""
    with open(os.path.join(OUTPUT_DIR, "D-Detect_College_Viva_and_Theory_Guide.html"), "w", encoding="utf-8") as f:
        f.write(viva_html)

    # 3. Master Doc HTML
    master_html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>D-Detect: Master Project Documentation</title>
  {HTML_STYLE}
</head>
<body>
<div class="container">
  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <h1>D-Detect: Smart Mobile Evidence Vault & Timeline Manager</h1>
  <div class="subtitle">Master Project Report & System Architecture Specification — Final Year Capstone Project</div>

  <h2>1. Project Abstract & Overview</h2>
  <p><strong>Project Developer:</strong> Diya Jothikumar (Final Year CSE)<br>
  <strong>Support Email:</strong> divv.workkss@gmail.com<br>
  <strong>Target Platform:</strong> Android (SDK 24–36, Android 7.0+) and iOS (via Expo Go)<br>
  <strong>Technology Stack:</strong> React Native (Expo SDK 55), TypeScript 5.9, Node.js 22, Express/Hono, SQLite (FTS5), Firebase Firestore & Cloud Storage</p>
  
  <p>In legal proceedings, workplace disputes, insurance claims, and personal financial tracking, individuals frequently face evidence disorganization. Receipts fade or get buried in photo galleries, verbal agreements in meetings are forgotten, critical email dates go missing, and financial transactions lack documented context. D-Detect is an offline-first mobile evidence vault and intelligent chronological timeline management system that provides a structured, tamper-evident digital repository with verifiable chronological provenance.</p>

  <h2>2. System Architecture</h2>
  <table>
    <tr>
      <th>Layer</th>
      <th>Technology</th>
      <th>Role & Responsibilities</th>
    </tr>
    <tr>
      <td>Mobile Frontend</td>
      <td>React Native, Expo SDK 55, TypeScript</td>
      <td>Gesture-driven UI, camera/audio capture, offline caching via AsyncStorage, 60fps animations.</td>
    </tr>
    <tr>
      <td>Backend Engine</td>
      <td>Node.js 22, Hono & Express</td>
      <td>REST API endpoints (/daybook, /ask, /files, /meetings), multi-tenant auth validation, NLP query pipeline.</td>
    </tr>
    <tr>
      <td>Local Database</td>
      <td>SQLite with FTS5 Full-Text Search</td>
      <td>High-speed inverted index text search, transactional storage with Write-Ahead Logging (WAL).</td>
    </tr>
    <tr>
      <td>Cloud Vault</td>
      <td>Firebase Firestore & Cloud Storage</td>
      <td>Encrypted cloud metadata backup, remote file synchronization, and authentication bridge.</td>
    </tr>
    <tr>
      <td>Testing Suite</td>
      <td>Vitest & Node Test Runner</td>
      <td>1,059 mobile client tests and 606 backend tests verifying math, security, and rendering (1,665 total tests).</td>
    </tr>
  </table>
</div>
</body>
</html>"""
    with open(os.path.join(OUTPUT_DIR, "D-Detect_Master_Project_Documentation.html"), "w", encoding="utf-8") as f:
        f.write(master_html)

    # 4. Developer Cheatsheet HTML
    dev_html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>D-Detect: Developer Handover Cheatsheet</title>
  {HTML_STYLE}
</head>
<body>
<div class="container">
  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <h1>D-Detect: Developer's Handover & Delivery Cheatsheet</h1>
  <div class="subtitle">Private Step-by-Step Delivery Guide for Ayush — Pre-Handover Checklist, Client FAQs & Live Script</div>

  <div class="callout">
    <div class="callout-title">CONFIDENTIAL DEVELOPER MANUAL</div>
    This document is your private master reference for today's client delivery. It contains the exact checklist, ready-to-copy chat messages, phone/laptop setup steps, and word-for-word responses to client questions so you can handle the entire handover smoothly and confidently.
  </div>

  <h2>1. The 1-Hour Pre-Delivery Checklist</h2>
  <ul>
    <li><strong>Step 1:</strong> Ensure 'D-Detect_Complete_Project_Source.zip' is ready in your Downloads folder and uploaded to your Google Drive / OneDrive.</li>
    <li><strong>Step 2:</strong> Ensure your own mobile phone has Expo Go installed and has tested scanning the terminal QR code.</li>
    <li><strong>Step 3:</strong> Verify that 'npm start' in detact/server and 'npx expo start --tunnel' in detact run without errors.</li>
    <li><strong>Step 4:</strong> Have AnyDesk, TeamViewer, or Google Meet ready if you are helping her set it up remotely.</li>
    <li><strong>Step 5:</strong> Have her GitHub username ready if her institute requires adding her to https://github.com/egon999/d-detect.</li>
  </ul>

  <h2>2. 3-Minute Live Demonstration Script</h2>
  <p>Follow this exact script when presenting the app to her:</p>
  <ul>
    <li><strong>Minute 1 (Sign-In & Masthead):</strong> "Here is D-Detect. Notice the animated Detective mascot with real-time vector blinking and fedora tilt physics. We support both Google OAuth and offline Guest sign-in." (Tap Guest Mode).</li>
    <li><strong>Minute 2 (Timeline & Capture):</strong> "Here is the Daybook Timeline. Every bill, contract, and voice memo is grouped by date bands. Let's click Capture and snap a receipt. The app computes an HMAC-SHA256 cryptographic seal, guaranteeing the file cannot be tampered with."</li>
    <li><strong>Minute 3 (Query Assistant & Bento Finance):</strong> "Now let's go to the Ask tab. I'll type 'What did I spend on electricity?' The assistant uses SQLite FTS5 search to find the exact bill and answers with verified source citations. Lastly, in the Money tab, our financial forensics automatically flag recurring bills and double payments."</li>
  </ul>
</div>
</body>
</html>"""
    with open(os.path.join(OUTPUT_DIR, "D-Detect_Developer_Handover_Cheatsheet.html"), "w", encoding="utf-8") as f:
        f.write(dev_html)

    # 5. Interactive Slides HTML
    slides_html = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>D-Detect: Project Presentation Slides</title>
  __HTML_STYLE__
  <style>
    .slide {
      background: white;
      border: 2px solid #CBD5E1;
      border-radius: 12px;
      padding: 30px 40px;
      margin-bottom: 30px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.05);
    }
    .slide-num {
      font-size: 12px;
      font-weight: bold;
      color: #94A3B8;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .notes-box {
      background: #F8FAFC;
      border-left: 3px solid #64748B;
      padding: 10px 15px;
      margin-top: 15px;
      font-size: 13px;
      color: #475569;
  </style>
</head>
<body>
<div class="container">
  <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  <h1>D-Detect: Capstone Presentation Deck</h1>
  <div class="subtitle">Complete 10-Slide Presentation with Speaker Notes & Defense Talking Points</div>

  <div class="slide">
    <div class="slide-num">Slide 1 of 10</div>
    <h2>D-Detect: Smart Mobile Evidence Vault & Case Timeline Manager</h2>
    <p><strong>Presenter / Developer:</strong> Diya Jothikumar (Final Year CSE)<br>
    <strong>Department:</strong> Computer Science & Engineering<br>
    <strong>Target Platform:</strong> Android (SDK 24-36) & iOS (Expo Go)</p>
    <div class="notes-box"><strong>Speaker Notes:</strong> Good morning respected evaluators. Today I am presenting D-Detect, an intelligent mobile evidence vault and chronological timeline management system.</div>
  </div>

  <div class="slide">
    <div class="slide-num">Slide 2 of 10</div>
    <h2>The Real-World Problem: Disorganized Evidence</h2>
    <ul>
      <li>Evidence Scattering: Receipts, contracts, and audio records are buried across photo galleries, chat apps, and voice memos.</li>
      <li>Lack of Chronological Context: Difficult to reconstruct exact event timelines during legal disputes or financial audits.</li>
      <li>Evidence Tampering Risks: Digital files lack cryptographic seals to prove they have not been edited after the fact.</li>
      <li>Inefficient Search: Locating an invoice or verbal agreement from six months ago takes hours of manual digging.</li>
    </ul>
    <div class="notes-box"><strong>Speaker Notes:</strong> In legal disputes or rental conflicts, proving what happened and when is the main obstacle. D-Detect solves this by acting as a tamper-evident digital diary.</div>
  </div>

  <div class="slide">
    <div class="slide-num">Slide 3 of 10</div>
    <h2>Proposed Solution: D-Detect</h2>
    <ul>
      <li>Consolidated Digital Vault: Combines bills, receipts, contracts, and meeting recordings into one unified app.</li>
      <li>Interactive Chronological Timeline: Automatically organizes all records into date-banded visual cards.</li>
      <li>Natural Language Assistant: Multi-lingual query engine (English, Hindi, Hinglish) with source-verified citations.</li>
      <li>Financial Forensics: Detects recurring expenses, budget anomalies, and duplicate payments automatically.</li>
      <li>Cryptographic Integrity: HMAC-SHA256 file fingerprints ensure unalterable proof.</li>
    </ul>
    <div class="notes-box"><strong>Speaker Notes:</strong> D-Detect gives users an all-in-one timeline feed, smart conversational search, and automatic financial anomaly alerts.</div>
  </div>

  <div class="slide">
    <div class="slide-num">Slide 4 of 10</div>
    <h2>High-Level System Architecture</h2>
    <ul>
      <li>Mobile Client Tier: Built with React Native & Expo SDK 55, delivering 60fps animations and offline caching.</li>
      <li>Backend Engine Tier: Node.js 22 with Express/Hono REST APIs managing ingestion, search, and HMAC sealing.</li>
      <li>Database Tier: In-process SQLite with Write-Ahead Logging (WAL) and FTS5 inverted search indexing.</li>
      <li>Cloud Vault: Firebase Firestore for encrypted metadata sync and Cloud Storage for remote file backup.</li>
    </ul>
    <div class="notes-box"><strong>Speaker Notes:</strong> Our 3-tier architecture separates client presentation from backend processing and local database indexing for maximum performance.</div>
  </div>

  <div class="slide">
    <div class="slide-num">Slide 5 of 10</div>
    <h2>Key Functional Modules</h2>
    <ul>
      <li>Daybook Timeline: Visual chronological feed organizing events, receipts, and notes by date.</li>
      <li>Ask Assistant: Conversational retrieval engine that answers questions grounded strictly in saved evidence.</li>
      <li>Money & Bento Analytics: Financial intelligence tracking monthly spending, recurring bill cadence, and duplicate charges.</li>
      <li>Meeting Audio Ingestion: Audio recording pipeline that transcribes speech, captures decisions, and creates action tasks.</li>
    </ul>
    <div class="notes-box"><strong>Speaker Notes:</strong> Each module serves a distinct real-world role: recording evidence, searching it conversationally, analyzing financial trends, and capturing meetings.</div>
  </div>

  <div class="slide">
    <div class="slide-num">Slide 6 of 10</div>
    <h2>Database Design & Multi-Tenant Security</h2>
    <ul>
      <li>Embedded SQLite: In-process database with zero network overhead, capable of 100,000+ reads per second.</li>
      <li>FTS5 Virtual Tables: Inverted token indexing enabling sub-second search across thousands of records.</li>
      <li>Strict Tenant Isolation: Every query enforces 'WHERE owner_id = ?' via Bearer token validation.</li>
      <li>Zero Cross-Tenant Leakage: User A can never view, search, or alter User B's records.</li>
    </ul>
    <div class="notes-box"><strong>Speaker Notes:</strong> Multi-tenancy ensures complete privacy. Even on shared databases, every record is isolated by owner identity.</div>
  </div>

  <div class="slide">
    <div class="slide-num">Slide 7 of 10</div>
    <h2>AI Grounding (RAG) & Signal Algorithms</h2>
    <ul>
      <li>Retrieval-Augmented Generation (RAG): Natural language assistant queries ground-truth FTS5 records before answering.</li>
      <li>Zero Hallucinations: The model is strictly constrained to cite retrieved source IDs and admits when records are absent.</li>
      <li>Multi-Lingual Support: Understands natural conversational queries in English, Hindi, and Hinglish.</li>
      <li>Signal Detection Algorithms: Automatically flags missing monthly bills and identical payments within short windows.</li>
    </ul>
    <div class="notes-box"><strong>Speaker Notes:</strong> By using RAG, we guarantee that the assistant never invents facts—it only quotes real receipts and notes from the user's database.</div>
  </div>

  <div class="slide">
    <div class="slide-num">Slide 8 of 10</div>
    <h2>Implementation & Verification Metrics</h2>
    <ul>
      <li>100% TypeScript 5.9: Strict static typing across both client and server eliminates runtime bugs.</li>
      <li>Frontend Test Suite: 1,059 Vitest automated tests covering UI rendering, gestures, theme contrast, and offline caching.</li>
      <li>Backend Test Suite: 606 Node.js automated tests verifying tenancy, HMAC hashing, FTS5 search, and anomaly detectors.</li>
      <li>Overall QA Score: 1,665 total automated tests passing with 0 failures.</li>
    </ul>
    <div class="notes-box"><strong>Speaker Notes:</strong> Our comprehensive test coverage of 1,665 passing tests demonstrates engineering rigor and production-grade reliability.</div>
  </div>

  <div class="slide">
    <div class="slide-num">Slide 9 of 10</div>
    <h2>Live Application Demonstration Flow</h2>
    <ul>
      <li>Step 1: Sign-In with animated Detective Mascot vector blinking and Google OAuth / Guest authentication.</li>
      <li>Step 2: Browse the Daybook Timeline feed with date-banded cards and filter chips.</li>
      <li>Step 3: Capture a receipt with instant preview and HMAC-SHA256 cryptographic sealing.</li>
      <li>Step 4: Ask conversational questions in the Ask tab with direct receipt proof citations.</li>
      <li>Step 5: View spending breakdowns and duplicate bill alerts in the Money tab.</li>
    </ul>
    <div class="notes-box"><strong>Speaker Notes:</strong> In our live demo, we showcase the end-to-end workflow from evidence capture to timeline indexing and natural language querying.</div>
  </div>

  <div class="slide">
    <div class="slide-num">Slide 10 of 10</div>
    <h2>Conclusion & Future Scope</h2>
    <ul>
      <li>Conclusion: Successfully built and verified an offline-first mobile evidence vault with production reliability.</li>
      <li>Future Scope 1: Account Aggregator API integration for automated bank and UPI statement ingestion.</li>
      <li>Future Scope 2: Blockchain-anchored timestamping on Ethereum/Polygon for verifiable courtroom admissibility.</li>
      <li>Future Scope 3: Edge-based on-device OCR and speech recognition models for zero-cloud latency.</li>
      <li>Thank You! Questions & Discussion.</li>
    </ul>
    <div class="notes-box"><strong>Speaker Notes:</strong> Thank you respected evaluators for your time and feedback. We are now open for your questions and discussion.</div>
  </div>
</div>
</body>
</html>""".replace("__HTML_STYLE__", HTML_STYLE)
    with open(os.path.join(OUTPUT_DIR, "D-Detect_Project_Presentation.html"), "w", encoding="utf-8") as f:
        f.write(slides_html)

    print("All HTML documents generated successfully.")

def main():
    print("=== Starting Complete Handover Suite Generation ===")
    
    # Clean old non-deliverable markdown files
    clean_old_markdown_files()

    # Generate clean ZIP archive
    generate_clean_zip()

    # Generate HTML versions
    generate_html_files()

    # Generate Word Documents via COM
    print("Starting MS Word COM automation...")
    word_app = win32com.client.Dispatch("Word.Application")
    word_app.Visible = False
    try:
        generate_handover_guide(word_app)
        generate_master_doc(word_app)
        generate_viva_guide(word_app)
        generate_dev_cheatsheet(word_app)
    finally:
        word_app.Quit()

    # Copy the dedicated iOS & Mobile Handover Guide directly into Downloads root as well!
    downloads_root = r"C:\Users\ayush\Downloads"
    src_handover = os.path.join(OUTPUT_DIR, "D-Detect_iOS_and_Mobile_Handover_Guide.docx")
    dst_handover = os.path.join(downloads_root, "D-Detect_iOS_and_Mobile_Handover_Guide.docx")
    shutil.copy2(src_handover, dst_handover)
    print(f"Copied dedicated iOS handover guide to: {dst_handover}")

    # Generate PowerPoint presentation via COM
    print("Starting MS PowerPoint COM automation...")
    generate_presentation()

    print("=== Handover Suite Build Complete! ===")

if __name__ == "__main__":
    main()
