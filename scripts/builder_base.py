import os
import sys
import zipfile
import shutil
import win32com.client

OUTPUT_DIR = r"C:\Users\ayush\Downloads\D-Detect_Submission_Package"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Colors in BGR for Word COM
COLOR_NAVY = 0x803010
COLOR_DARK = 0x222222
COLOR_MUTED = 0x666666
COLOR_BLUE = 0xC06000

class DocxWriter:
    def __init__(self, word_app, title, subtitle):
        self.word = word_app
        self.doc = word_app.Documents.Add()
        self.doc.PageSetup.TopMargin = 54
        self.doc.PageSetup.BottomMargin = 54
        self.doc.PageSetup.LeftMargin = 54
        self.doc.PageSetup.RightMargin = 54
        self.sel = word_app.Selection

        # Title
        self.sel.Font.Name = "Calibri"
        self.sel.Font.Size = 22
        self.sel.Font.Bold = True
        self.sel.Font.Color = COLOR_NAVY
        self.sel.TypeText(title + "\n")

        # Subtitle
        self.sel.Font.Size = 11
        self.sel.Font.Bold = False
        self.sel.Font.Color = COLOR_MUTED
        self.sel.TypeText(subtitle + "\n")
        self.add_divider()

    def add_divider(self):
        self.sel.Font.Size = 10
        self.sel.Font.Color = 0xCCCCCC
        self.sel.TypeText("―" * 55 + "\n\n")

    def add_h1(self, text):
        self.sel.Font.Name = "Calibri"
        self.sel.Font.Size = 15
        self.sel.Font.Bold = True
        self.sel.Font.Color = COLOR_NAVY
        self.sel.TypeText("\n" + text + "\n")

    def add_h2(self, text):
        self.sel.Font.Name = "Calibri"
        self.sel.Font.Size = 12
        self.sel.Font.Bold = True
        self.sel.Font.Color = COLOR_BLUE
        self.sel.TypeText("\n" + text + "\n")

    def add_p(self, text, bold_prefix=""):
        self.sel.Font.Name = "Calibri"
        self.sel.Font.Size = 10.5
        self.sel.Font.Color = COLOR_DARK
        if bold_prefix:
            self.sel.Font.Bold = True
            self.sel.TypeText(bold_prefix + " ")
            self.sel.Font.Bold = False
        self.sel.TypeText(text + "\n\n")

    def add_bullet(self, text, bold_prefix=""):
        self.sel.Font.Name = "Calibri"
        self.sel.Font.Size = 10.5
        self.sel.Font.Color = COLOR_DARK
        self.sel.Font.Bold = True
        self.sel.TypeText("• " + (bold_prefix + " " if bold_prefix else ""))
        self.sel.Font.Bold = False
        self.sel.TypeText(text + "\n")

    def add_callout(self, text, title="IMPORTANT NOTE"):
        self.sel.Font.Name = "Calibri"
        self.sel.Font.Size = 10
        self.sel.Font.Bold = True
        self.sel.Font.Color = COLOR_NAVY
        self.sel.TypeText("\n[" + title + "]\n")
        self.sel.Font.Bold = False
        self.sel.Font.Color = 0x444444
        self.sel.TypeText(text + "\n\n")

    def add_code(self, code_text):
        self.sel.Font.Name = "Consolas"
        self.sel.Font.Size = 9.5
        self.sel.Font.Bold = False
        self.sel.Font.Color = 0x202020
        self.sel.TypeText(code_text + "\n\n")

    def add_table(self, headers, rows):
        table = self.doc.Tables.Add(self.sel.Range, len(rows) + 1, len(headers))
        table.Borders.Enable = True
        table.Borders.InsideColor = 0xDDDDDD
        table.Borders.OutsideColor = 0xAAAAAA

        for col_idx, h in enumerate(headers):
            cell = table.Cell(1, col_idx + 1)
            cell.Range.Font.Name = "Calibri"
            cell.Range.Font.Size = 10
            cell.Range.Font.Bold = True
            cell.Range.Font.Color = 0xFFFFFF
            cell.Shading.BackgroundPatternColor = COLOR_NAVY
            cell.Range.Text = h

        for row_idx, row in enumerate(rows):
            for col_idx, val in enumerate(row):
                cell = table.Cell(row_idx + 2, col_idx + 1)
                cell.Range.Font.Name = "Calibri"
                cell.Range.Font.Size = 9.5
                cell.Range.Font.Bold = False
                cell.Range.Font.Color = COLOR_DARK
                if row_idx % 2 == 1:
                    cell.Shading.BackgroundPatternColor = 0xF5F5F5
                cell.Range.Text = str(val)

        self.sel.EndOf(10, 0)
        self.sel.TypeText("\n")

    def save_and_close(self, filename):
        full_path = os.path.join(OUTPUT_DIR, filename)
        self.doc.SaveAs(full_path, 16) # 16 = wdFormatXMLDocument (.docx)
        self.doc.Close()
        print(f"Generated Word Document: {full_path}")

print("DocxWriter class ready.")
