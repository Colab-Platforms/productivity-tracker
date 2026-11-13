import PDFDocument from "pdfkit";

// Builds the PDF of a letter that HR TYPED in the app (an uploaded letter is stored exactly as uploaded). Plain A4 text, no images, no new dependency
// (pdfkit is already used for payslips).
export function buildLetterPdf(input: { company: string; title: string; reason: string; text: string; issueDate: string; employeeName: string; employeeCode: string | null; designation: string | null; issuerName: string; issuerRole: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 64, info: { Title: input.title, Author: input.company } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(16).text(input.company);
    doc.moveDown(0.3).font("Helvetica").fontSize(9).fillColor("#666666").text("Confidential - warning letter").fillColor("#000000");
    doc.moveDown(1.2).font("Helvetica-Bold").fontSize(14).text("WARNING LETTER", { align: "center" });
    doc.moveDown(1);
    doc.font("Helvetica").fontSize(10.5);
    doc.text(`Date: ${input.issueDate}`);
    doc.moveDown(0.6);
    doc.text(`To: ${input.employeeName}${input.employeeCode ? ` (${input.employeeCode})` : ""}`);
    if (input.designation) doc.text(`Designation: ${input.designation}`);
    doc.moveDown(0.6);
    doc.font("Helvetica-Bold").text(`Subject: ${input.title}`);
    doc.font("Helvetica").moveDown(0.4).text(`Reason: ${input.reason}`);
    doc.moveDown(1);
    doc.text(input.text, { align: "left", lineGap: 3 });
    doc.moveDown(2);
    doc.text("Issued by:");
    doc.font("Helvetica-Bold").text(input.issuerName);
    doc.font("Helvetica").text(`${input.issuerRole}, ${input.company}`);
    doc.moveDown(2);
    doc.fontSize(8.5).fillColor("#666666").text("This letter was issued through Avatar HRMS. The employee's acknowledgment of receipt is recorded in the system.");
    doc.end();
  });
}
