import os
import sys
import zipfile
import shutil

OUTPUT_DIR = r"C:\Users\ayush\Downloads\D-Detect_Submission_Package"
os.makedirs(OUTPUT_DIR, exist_ok=True)

HTML_STYLE = """
<style>
  :root {
    --primary: #103080;
    --accent: #0060C0;
    --dark: #1A1A1A;
    --light: #F8F9FA;
    --border: #E2E8F0;
    --card: #FFFFFF;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.65;
    color: var(--dark);
    background: #F1F5F9;
    margin: 0;
    padding: 30px 15px;
  }
  .container {
    max-width: 900px;
    margin: 0 auto;
    background: var(--card);
    padding: 40px 50px;
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.06);
    border: 1px solid var(--border);
  }
  h1 {
    color: var(--primary);
    font-size: 26px;
    margin-top: 0;
    border-bottom: 2px solid #E2E8F0;
    padding-bottom: 12px;
  }
  .subtitle {
    color: #64748B;
    font-size: 14px;
    margin-top: -6px;
    margin-bottom: 25px;
  }
  h2 {
    color: var(--accent);
    font-size: 19px;
    margin-top: 28px;
    margin-bottom: 10px;
  }
  h3 {
    font-size: 15px;
    color: var(--dark);
    margin-top: 18px;
  }
  p, li {
    font-size: 14px;
    color: #334155;
  }
  ul {
    padding-left: 20px;
  }
  li {
    margin-bottom: 8px;
  }
  .callout {
    background: #EFF6FF;
    border-left: 4px solid var(--accent);
    padding: 15px 20px;
    border-radius: 0 8px 8px 0;
    margin: 20px 0;
    font-size: 13.5px;
  }
  .callout-title {
    font-weight: bold;
    color: var(--primary);
    margin-bottom: 6px;
  }
  pre {
    background: #0F172A;
    color: #F8FAFC;
    padding: 15px 20px;
    border-radius: 8px;
    font-family: Consolas, 'Courier New', monospace;
    font-size: 13px;
    overflow-x: auto;
    white-space: pre-wrap;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 20px 0;
    font-size: 13.5px;
  }
  th, td {
    padding: 10px 14px;
    text-align: left;
    border: 1px solid var(--border);
  }
  th {
    background: var(--primary);
    color: white;
    font-weight: 600;
  }
  tr:nth-child(even) {
    background: #F8FAFC;
  }
  .print-btn {
    display: inline-block;
    background: var(--primary);
    color: white;
    padding: 8px 16px;
    border-radius: 6px;
    text-decoration: none;
    font-size: 13px;
    font-weight: bold;
    margin-bottom: 20px;
    cursor: pointer;
    border: none;
  }
  @media print {
    body { background: white; padding: 0; }
    .container { box-shadow: none; border: none; padding: 0; }
    .print-btn { display: none; }
  }
</style>
"""

def generate_clean_zip():
    source_dir = r"E:\Project Evid\detact"
    zip_path = os.path.join(OUTPUT_DIR, "D-Detect_Complete_Project_Source.zip")

    EXCLUDE_DIRS = {
        "node_modules", ".git", ".expo", ".smoke", ".data",
        "artifacts", "build", "dist", ".gradle"
    }

    print(f"Creating clean project ZIP archive at: {zip_path}")
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(source_dir):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
            for file in files:
                if file.endswith((".log", ".shm", ".wal", ".tmp")):
                    continue
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, source_dir)
                zipf.write(full_path, os.path.join("detact", rel_path))

        # Also bundle root APK if present
        root_apk = r"E:\Project Evid\detact-release.apk"
        if os.path.exists(root_apk):
            zipf.write(root_apk, "detact-release.apk")

    print(f"Clean ZIP created successfully! Size: {os.path.getsize(zip_path) / (1024*1024):.2f} MB")

def clean_old_markdown_files():
    for f in os.listdir(OUTPUT_DIR):
        if f.endswith(".md") or f.endswith(".txt"):
            old_path = os.path.join(OUTPUT_DIR, f)
            try:
                os.remove(old_path)
                print(f"Cleaned old non-deliverable file: {f}")
            except Exception as e:
                pass

print("HTML and ZIP packager ready.")
