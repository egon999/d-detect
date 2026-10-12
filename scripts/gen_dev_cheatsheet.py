import os
import win32com.client
from builder_base import DocxWriter, OUTPUT_DIR

def generate_dev_cheatsheet(word_app):
    w = DocxWriter(
        word_app,
        "D-Detect: Developer's Handover & Delivery Cheatsheet",
        "Private Step-by-Step Delivery Guide for Ayush — Pre-Handover Checklist, Client FAQs & Live Script"
    )

    w.add_callout(
        "This document is your private master reference for today's client delivery. "
        "It contains the exact checklist, ready-to-copy chat messages, phone/laptop setup steps, and word-for-word responses "
        "to client questions so you can handle the entire handover smoothly and confidently without needing external help.",
        "CONFIDENTIAL DEVELOPER MANUAL"
    )

    w.add_h1("1. The 1-Hour Pre-Delivery Checklist")
    w.add_bullet("Ensure 'D-Detect_Complete_Project_Source.zip' is ready in your Downloads folder and uploaded to your Google Drive / OneDrive.", "Step 1:")
    w.add_bullet("Ensure your own mobile phone has Expo Go installed and has tested scanning the terminal QR code.", "Step 2:")
    w.add_bullet("Verify that 'npm start' in detact/server and 'npx expo start --tunnel' in detact run without errors.", "Step 3:")
    w.add_bullet("Have AnyDesk, TeamViewer, or Google Meet ready if you are helping her set it up remotely.", "Step 4:")
    w.add_bullet("Have her GitHub username ready if her institute requires adding her to https://github.com/egon999/d-detect.", "Step 5:")

    w.add_h1("2. Packaging & Delivering Source Files")
    w.add_p(
        "To give her a clean, lightweight experience, never send the raw working directory containing 'node_modules' or build caches, "
        "which can be over 1 GB in size. Instead, provide the clean archive 'D-Detect_Complete_Project_Source.zip' (~50 MB), which includes:\n"
        "• All frontend source code (app/, src/, assets/)\n"
        "• The backend server code (server/src/, server/package.json)\n"
        "• Production Android release APK (detact-release.apk)\n"
        "• All documentation and setup guides in Word and PowerPoint format"
    )

    w.add_h1("3. Sequenced Client Messages (Ready to Copy & Paste)")
    w.add_h2("Message 1: Initial Handover & Deliverables Notification")
    w.add_code(
        "Hi! Great news—the complete D-Detect project is finalized, verified, and ready for you today!\n\n"
        "I've packaged everything into a clean delivery bundle for you, including:\n"
        "1. Full Source Code (Clean ZIP archive ready to extract)\n"
        "2. Production Android Release APK (detact-release.apk ready to install)\n"
        "3. Complete Project Documentation in Microsoft Word (.docx)\n"
        "4. College Viva & Defense Guide with 22+ questions and answers\n"
        "5. 10-Slide Presentation Deck in PowerPoint (.pptx)\n\n"
        "I'm attaching the download link here. Let me know once you download it, and we can hop on a quick call "
        "to walk through the live demo and get it running on your laptop!"
    )

    w.add_h2("Message 2: Setting Up the Live Demo Call")
    w.add_code(
        "For our handover call, you don't need any prior technical knowledge at all. "
        "I'll share my screen first to demonstrate how the mobile app works—showing you the timeline, "
        "the query assistant, and the financial forensics. Then, I'll guide you click-by-click to get it running on your laptop. "
        "Are you free in about 15 minutes?"
    )

    w.add_h2("Message 3: Post-Handover Wrap-Up & Encouragement")
    w.add_code(
        "You did an amazing job during the walkthrough! You now have the full project running on your laptop and phone, "
        "along with the complete Word documentation, presentation slides, and the viva Q&A guide. "
        "Take a look at the '03_College_Viva_and_Theory_Guide.docx' before your college evaluation—it covers all the questions "
        "your professors could ask. If anything comes up before your submission, feel free to message me anytime. Good luck!"
    )

    w.add_h1("4. Anticipated Client Questions & Word-for-Word Answers")

    w.add_h2("Q: 'My laptop is completely clean and I don't know programming. Can I really run this?'")
    w.add_p(
        "Your Answer:\n"
        "'Yes, 100%! We only need two small tools: Node.js (which runs the server) and Cloudflared (which connects it to your phone). "
        "Both have standard Windows 'Next-Next-Install' setup wizards. I will walk you through each step, and once installed, "
        "starting the application is just two simple commands.'"
    )

    w.add_h2("Q: 'Do I need an Android phone, or can I show this on my iPhone?'")
    w.add_p(
        "Your Answer:\n"
        "'You can show it on both! If you or your professors have an iPhone, you simply open the Expo Go app from the App Store and scan the QR code. "
        "The app runs natively on iOS. If you have an Android phone, you can either use Expo Go or install the standalone release APK directly.'"
    )

    w.add_h2("Q: 'What if my college auditorium has poor Wi-Fi during the presentation?'")
    w.add_p(
        "Your Answer:\n"
        "'That is exactly why we use Cloudflare Tunnel! Because Cloudflare Tunnel operates over the public internet, you can simply turn on your mobile hotspot "
        "or use mobile 4G/5G data. It bypasses college Wi-Fi restrictions completely and connects securely every time.'"
    )

    w.add_h2("Q: 'What should I say if my professor asks how the AI works?'")
    w.add_p(
        "Your Answer:\n"
        "'Tell them: We use Retrieval-Augmented Generation (RAG). When the user asks a question, the server first queries the SQLite FTS5 full-text search engine "
        "to retrieve only the user's factual receipts and notes. It then synthesizes the answer with direct citations. This guarantees zero hallucinations.'"
    )

    w.add_h1("5. Step-by-Step Remote Handover Procedure (During the Screen Share)")
    w.add_p(
        "When you connect with her on AnyDesk, TeamViewer, or Google Meet, follow this sequence:\n"
        "1. Open Chrome on her laptop and download Node.js LTS (https://nodejs.org). Run the installer with default settings.\n"
        "2. Download Cloudflared Windows MSI (https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi). Install it.\n"
        "3. Have her download and extract 'D-Detect_Complete_Project_Source.zip' to 'C:\\Projects\\detact' or Desktop.\n"
        "4. Open Command Prompt 1: Type 'cd C:\\Projects\\detact\\server && npm start'.\n"
        "5. Open Command Prompt 2: Type 'cloudflared tunnel --url http://localhost:8787'.\n"
        "6. Open Command Prompt 3: Type 'cd C:\\Projects\\detact && npx expo start --tunnel'.\n"
        "7. Have her open her iPhone camera or Android Expo Go and scan the QR code. Once the app loads on her phone, congratulate her!"
    )

    w.add_h1("6. 3-Minute Live Demonstration Script")
    w.add_p(
        "Follow this exact script when presenting the app to her (and tell her to use this exact script for her college defense):\n\n"
        "• Minute 1 (Sign-In & Masthead): 'Here is D-Detect. Notice the animated Detective mascot with real-time vector blinking and fedora tilt physics. "
        "We support both Google OAuth and offline Guest sign-in.' (Tap Guest Mode).\n\n"
        "• Minute 2 (Timeline & Capture): 'Here is the Daybook Timeline. Every bill, contract, and voice memo is grouped by date bands. "
        "Let's click Capture and snap a receipt. The app computes an HMAC-SHA256 cryptographic seal, guaranteeing the file cannot be tampered with.'\n\n"
        "• Minute 3 (Query Assistant & Bento Finance): 'Now let's go to the Ask tab. I'll type \"What did I spend on electricity?\" "
        "The assistant uses SQLite FTS5 search to find the exact bill and answers with verified source citations. "
        "Lastly, in the Money tab, our financial forensics automatically flag recurring bills and double payments.'"
    )

    w.save_and_close("D-Detect_Developer_Handover_Cheatsheet.docx")

print("generate_dev_cheatsheet defined.")
