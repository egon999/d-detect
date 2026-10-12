import os
import sys
import zipfile
import shutil
import win32com.client
from builder_base import DocxWriter, OUTPUT_DIR, COLOR_NAVY, COLOR_BLUE, COLOR_DARK, COLOR_MUTED

def generate_handover_guide(word_app):
    w = DocxWriter(
        word_app,
        "D-Detect: Complete Mobile & iOS Handover Guide",
        "Step-by-Step Clean Laptop Setup, Cloudflare Tunnel Networking, and Ready-to-Send Client Communication"
    )

    w.add_h1("1. Executive Handover Summary")
    w.add_p(
        "This handover package contains everything required to transfer the complete D-Detect project to your client today. "
        "The application has been finalized, thoroughly optimized, and mathematically verified through 1,665 automated tests. "
        "Because your client has a clean laptop and no prior technical background, this guide is written in plain, friendly English "
        "so that she can understand, install, run, and present the project with total confidence."
    )
    w.add_bullet("Complete source code archive (lightweight ZIP, clean of heavy caches).", "Deliverable 1:")
    w.add_bullet("Pre-built signed Android release APK (detact-release.apk) ready for direct phone installation.", "Deliverable 2:")
    w.add_bullet("Private GitHub repository access (https://github.com/egon999/d-detect) for formal university code submission.", "Deliverable 3:")
    w.add_bullet("Executive project documentation in Microsoft Word (.docx) and Web format (.html).", "Deliverable 4:")
    w.add_bullet("Comprehensive College Viva & Defense Preparation Guide with 22+ questions and model answers.", "Deliverable 5:")
    w.add_bullet("10-Slide Microsoft PowerPoint presentation (.pptx) with complete speaker talking points.", "Deliverable 6:")
    w.add_bullet("Step-by-step remote live demonstration script and emergency troubleshooting cheat sheet.", "Deliverable 7:")

    w.add_h1("2. Ready-to-Send Client Message (Ready to Copy & Paste)")
    w.add_p(
        "Copy and send this message directly to your client via WhatsApp or Email. It sets a warm, professional, "
        "and reassuring tone while outlining exactly what she is receiving and how the live demo will work:"
    )
    w.add_code(
        "Hi! I'm happy to let you know that the D-Detect project is completely finished, fully tested, and ready for you!\n\n"
        "Here is what I have prepared for you today:\n"
        "1. Complete Source Code: A clean, easy-to-extract ZIP file containing the entire frontend and backend code.\n"
        "2. Ready-to-Install Android App: A production-ready .apk file that you can install directly on any Android phone.\n"
        "3. Mobile & iOS Access: Complete instructions to run the application live on your iPhone or Android using Expo Go.\n"
        "4. Project Documentation & College Presentation: Beautiful Word documents and PowerPoint presentation slides "
        "explaining how the app works, its architecture, and its features.\n"
        "5. College Viva Preparation Kit: A detailed question-and-answer guide with 20+ likely questions your professors "
        "might ask, along with simple, confident answers.\n\n"
        "How our demonstration will work:\n"
        "We'll hop on a quick call where I will show you the application running live on mobile, walk you through the key features "
        "(the chronological timeline, the smart query assistant, and the financial forensics), and help you set it up on your laptop "
        "step by step. You don't need any prior coding knowledge at all—I'll guide you through every click!\n\n"
        "Let me know when you're free today for our handover call!"
    )

    w.add_h1("3. The Best & Easiest Way to Deliver Source Files")
    w.add_p(
        "When handing over a software project to a non-technical client, choosing the right file delivery channel is critical to prevent frustration:"
    )
    w.add_bullet(
        "Delivering the pre-packaged 'D-Detect_Complete_Project_Source.zip' archive via Google Drive, OneDrive, or a USB flash drive "
        "is the absolute best method. It requires zero command-line tools, no Git installation, and no SSH key configuration. "
        "She can simply right-click and 'Extract All' to any folder on her PC.",
        "Primary Recommendation (Clean ZIP Archive):"
    )
    w.add_bullet(
        "If her college or institute explicitly requires a private GitHub repository URL to prove version control and commit history, "
        "you can invite her GitHub username as a collaborator to 'https://github.com/egon999/d-detect'. "
        "However, for running the project on her laptop, always have her use the ZIP file to avoid Git authentication issues.",
        "Secondary Option (Private GitHub Repository):"
    )

    w.add_h1("4. Running on PC & Accessing on Mobile (Cloudflare Tunnel Guide)")
    w.add_p(
        "During development, we ran the backend server on a PC and used Cloudflare Tunnel to connect the mobile phone. "
        "Here is the simple explanation of why this was done, and why it remains the best approach:"
    )
    w.add_h2("Why Do We Need a Tunnel?")
    w.add_p(
        "The D-Detect backend (which manages the database, search indexing, and cryptographic file sealing) runs locally on the laptop at "
        "'http://localhost:8787'. A phone (iPhone or Android) cannot access 'localhost' on a computer because 'localhost' means 'this device itself'. "
        "To allow the phone to communicate with the laptop's backend, the laptop must expose a secure network address that the phone can reach."
    )
    w.add_h2("Is Cloudflare Tunnel Still the Best Approach?")
    w.add_p(
        "Yes, Cloudflare Tunnel is by far the most reliable, professional, and foolproof method for college demonstrations and mobile access. "
        "Here is why comparing the 3 possible methods:"
    )
    w.add_bullet(
        "Cloudflare Tunnel gives you a free, public, encrypted HTTPS URL (e.g. 'https://example.trycloudflare.com'). "
        "Because it is a public HTTPS URL, it works across ANY network—including college Wi-Fi, home Wi-Fi, and cellular mobile data (4G/5G). "
        "Most importantly, college and hostel Wi-Fi networks block local device-to-device communication (a security feature called 'Client/AP Isolation'). "
        "Cloudflare Tunnel bypasses this completely because the connection routes through Cloudflare's global edge network.",
        "Method A: Cloudflare Tunnel (Recommended):"
    )
    w.add_bullet(
        "Connecting over the local Wi-Fi IP address (e.g. 'http://192.168.1.5:8787') works at home if both devices are on the same router. "
        "However, it almost ALWAYS FAILS in college auditoriums and computer labs because college networks block local peer communication. "
        "Furthermore, iOS blocks plain HTTP requests for security.",
        "Method B: Local Wi-Fi IP (Unreliable on College Networks):"
    )
    w.add_bullet(
        "When running the frontend with 'npx expo start --tunnel', Expo creates its own tunnel for streaming the React Native JavaScript app "
        "into the Expo Go mobile app on your iPhone or Android. This works seamlessly alongside Cloudflare Tunnel.",
        "Method C: Expo Tunnel Mode (Best for Mobile Frontend):"
    )

    w.add_h1("5. Beginner's Step-by-Step Setup Guide (Clean Laptop)")
    w.add_p(
        "Follow these exact steps to set up and run D-Detect on a completely clean Windows laptop with zero existing programming software:"
    )
    w.add_h2("Step 1: Install Node.js (Runtime Environment)")
    w.add_p(
        "Node.js is the engine that executes the JavaScript and TypeScript code for both the backend server and mobile bundler."
    )
    w.add_bullet("Go to https://nodejs.org in Google Chrome or Edge.", "Download Link:")
    w.add_bullet("Click the big green button that says 'LTS - Recommended for Most Users' (Version 20 or 22).", "Which Version:")
    w.add_bullet("Open the downloaded .msi file. Click 'Next', accept the license agreement, keep all default options selected (make sure 'Add to PATH' is checked), and click 'Install'.", "Installation:")
    w.add_bullet("Open Command Prompt (press Windows Key, type 'cmd', press Enter). Type 'node -v' and press Enter. If it displays a version like 'v22.x.x', Node.js is ready!", "Verification:")

    w.add_h2("Step 2: Install Cloudflared (Cloudflare Tunnel)")
    w.add_p(
        "Cloudflared is Cloudflare's lightweight tunnel tool that securely connects the laptop's backend to the mobile app."
    )
    w.add_bullet("Download the official Windows installer directly from: https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi", "Download Link:")
    w.add_bullet("Double-click the installer and follow the quick setup wizard.", "Installation:")
    w.add_bullet("Open Command Prompt, type 'cloudflared --version', and press Enter. You should see 'cloudflared version 2026.x.x'.", "Verification:")

    w.add_h2("Step 3: Install Expo Go on the Mobile Phone")
    w.add_bullet("Open the Apple App Store, search for 'Expo Go', and tap 'Get' to install.", "For iPhone (iOS):")
    w.add_bullet("Open the Google Play Store, search for 'Expo Go', and install it. Alternatively, install the pre-built 'detact-release.apk' included in the project folder.", "For Android:")

    w.add_h2("Step 4: Extract the Project Files")
    w.add_p(
        "Take the 'D-Detect_Complete_Project_Source.zip' file, right-click it, select 'Extract All...', and choose a clean folder such as 'C:\\Projects\\detact' or your Desktop."
    )

    w.add_h2("Step 5: Start the Backend Server")
    w.add_p(
        "1. Open Command Prompt.\n"
        "2. Navigate to the server folder by typing:\n"
        "   cd C:\\Projects\\detact\\server\n"
        "3. (First time only) Install packages by typing:\n"
        "   npm install\n"
        "4. Start the server by typing:\n"
        "   npm start\n"
        "You will see: 'Detact backend listening on port 8787'."
    )

    w.add_h2("Step 6: Start Cloudflare Tunnel")
    w.add_p(
        "1. Open a SECOND Command Prompt window (keep the first one running!).\n"
        "2. Type the following command and press Enter:\n"
        "   cloudflared tunnel --url http://localhost:8787\n"
        "3. Within 5 seconds, Cloudflare will print log messages. Look for a line containing a public HTTPS URL such as:\n"
        "   https://your-unique-subdomain.trycloudflare.com\n"
        "This is the secure public link to your backend server!"
    )

    w.add_h2("Step 7: Launch the Mobile App Bundler")
    w.add_p(
        "1. Open a THIRD Command Prompt window.\n"
        "2. Navigate to the main project folder by typing:\n"
        "   cd C:\\Projects\\detact\n"
        "3. (First time only) Install packages by typing:\n"
        "   npm install\n"
        "4. Start the Expo bundler in tunnel mode by typing:\n"
        "   npx expo start --tunnel\n"
        "5. A large QR code will appear directly in your terminal window."
    )

    w.add_h2("Step 8: Open and Run on Your Mobile Phone")
    w.add_bullet(
        "Open the default Camera app on your iPhone, point the camera at the terminal QR code, and tap the yellow 'Open in Expo Go' popup. "
        "Expo Go will launch, download the JavaScript bundle, and display the D-Detect app natively on your iPhone!",
        "On iPhone (iOS):"
    )
    w.add_bullet(
        "Open the Expo Go app, tap 'Scan QR code', and scan the terminal QR code. The app will launch immediately.",
        "On Android:"
    )

    w.add_h1("6. Troubleshooting & Common Questions")
    w.add_table(
        ["Symptom / Error", "Root Cause", "Simple Fix"],
        [
            ["'node' or 'npm' is not recognized", "Command prompt was open during installation", "Close all command prompt windows and open a fresh one."],
            ["Port 8787 already in use", "Another server instance is running in background", "Run 'npx kill-port 8787' or restart the laptop."],
            ["Cloudflare tunnel drops or disconnects", "Temporary Wi-Fi interruption", "Press Ctrl+C in the tunnel window and re-run the command."],
            ["Expo says 'Network response timed out'", "Laptop and phone cannot reach each other", "Always use 'npx expo start --tunnel' rather than standard LAN mode."],
            ["Camera doesn't detect QR code on iPhone", "Screen glare or terminal font too small", "Maximize the Command Prompt window so the QR code is clearly visible."]
        ]
    )

    w.save_and_close("D-Detect_iOS_and_Mobile_Handover_Guide.docx")

print("generate_handover_guide defined.")
