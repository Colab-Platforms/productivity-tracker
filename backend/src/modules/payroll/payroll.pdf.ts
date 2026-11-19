// The payslip document. Built fresh on every request rather than stored, so
// it always matches the figures in the database - a slip corrected on Tuesday
// can never be downloaded as Monday's version. Nothing is written to storage,
// so there is nothing to grow, expire or go stale.

import PDFDocument from "pdfkit";
import { prisma } from "../../lib/prisma.js";
import { accessFor } from "../../lib/companyAccess.js";
import { canAccess } from "../../lib/companyAccess.logic.js";
import { getMonthAttendance } from "../attendance/attendance.service.js";
import { LOGOS } from "./payroll.logos.js";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const round2 = (n: number) => Math.round(n * 100) / 100;

// Indian digit grouping: 12,064.52 and 1,22,064.52, not 122,064.52.
function inr(n: number): string {
  const fixed = Math.abs(n).toFixed(2);
  const [whole, dec] = fixed.split(".");
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest
    ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3
    : last3;
  return `${n < 0 ? "-" : ""}${grouped}.${dec}`;
}

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty",
  "Ninety",
];

function under100(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return TENS[t] + (o ? ` ${ONES[o]}` : "");
}

function under1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h === 0) return under100(r);
  return `${ONES[h]} Hundred${r ? ` and ${under100(r)}` : ""}`;
}

// A payslip is a financial document, so the figure is written out as well as
// printed. A tampered digit is obvious when the words disagree with it.
function amountInWords(amount: number): string {
  const rupees = Math.floor(Math.abs(amount));
  const paise = Math.round((Math.abs(amount) - rupees) * 100);

  if (rupees === 0 && paise === 0) return "Zero Rupees only";

  const crore = Math.floor(rupees / 10000000);
  const lakh = Math.floor((rupees % 10000000) / 100000);
  const thousand = Math.floor((rupees % 100000) / 1000);
  const rest = rupees % 1000;

  const parts: string[] = [];
  if (crore) parts.push(`${under1000(crore)} Crore`);
  if (lakh) parts.push(`${under1000(lakh)} Lakh`);
  if (thousand) parts.push(`${under1000(thousand)} Thousand`);
  if (rest) parts.push(under1000(rest));

  let words = parts.join(" ") + " Rupees";
  if (paise) words += ` and ${under100(paise)} Paise`;
  return words + " only";
}

export type PayslipAccess = { pdf: Buffer; fileName: string };

/**
 * Build one payslip as a PDF.
 *
 * Access is decided here, not by the route, because a payslip is the most
 * sensitive document in the system: the owner may read their own once it is
 * published, and HR or an owner may read any in their company.
 */
export async function buildPayslipPdf(
  actorId: string,
  slipId: string,
): Promise<PayslipAccess> {
  const slip = await prisma.salarySlip.findUnique({
    where: { id: slipId },
    select: {
      id: true, platformId: true, userId: true, month: true, year: true,
      grossAmount: true, deductions: true, netAmount: true,
      daysInMonth: true, payableDays: true, absentDays: true,
      perDayRate: true, lossOfPay: true,
      otherDeduction: true, otherDeductionNote: true,
      status: true, generatedAt: true, approvedAt: true, publishedAt: true,
      user: {
        select: {
          firstName: true, lastName: true, employeeCode: true,
          designation: true, dateOfJoining: true,
          // The team stands in for a department, which is not stored separately.
          teamMemberships: {
            where: { isActive: true },
            orderBy: { isPrimary: "desc" },
            take: 1,
            select: { team: { select: { name: true } } },
          },
        },
      },
      platform: { select: { name: true, slug: true, timezone: true } },
    },
  });
  if (!slip) throw new Error("SLIP_NOT_FOUND");

  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { platformId: true, role: true },
  });
  if (!actor) throw new Error("USER_NOT_FOUND");

  const isSelf = slip.userId === actorId;
  const isHr = actor.role === "HR" || actor.role === "ADMIN";
  const sameCompany = canAccess(await accessFor(actorId), slip.platformId);
  const isOwner = false; // company reach now comes from the shared company-access rule

  if (isSelf) {
    // An employee may not read a figure HR has not released yet.
    if (!slip.publishedAt) throw new Error("NOT_PUBLISHED");
  } else if (!((isHr && sameCompany) || isOwner)) {
    throw new Error("NOT_ALLOWED");
  }

  const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

  const gross = num(slip.grossAmount);
  const lossOfPay = num(slip.lossOfPay);
  const otherDeduction = num(slip.otherDeduction);
  const deductions = num(slip.deductions);
  const net = num(slip.netAmount);
  const perDay = num(slip.perDayRate);
  const payableDays = num(slip.payableDays);
  const attendance = await getMonthAttendance(slip.userId, slip.year, slip.month);
  // A draft with no stored figures still needs a real month length.
  const daysInMonth = slip.daysInMonth || attendance.totals.daysInMonth;

  const name =
    [slip.user.firstName, slip.user.lastName].filter(Boolean).join(" ").trim() ||
    "Unnamed";
  const monthLabel = `${MONTHS[slip.month - 1]} ${slip.year}`;

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((resolve) =>
    doc.on("end", () => resolve(Buffer.concat(chunks))),
  );

  // The layout follows the company's own payslip: one ruled box, employee
  // details in two halves, earnings beside deductions, net, words, disclaimer.
  const LEFT = 40;
  const W = 515; // A4 width 595 less both margins
  const RIGHT = LEFT + W;
  const INK = "#000000";

  // Helvetica has no rupee glyph, so "Rs." is used throughout. A missing
  // glyph prints as a black box on a document somebody takes to a bank.
  const money = (n: number) => `Rs. ${inr(n)}`;
  const dayCount = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  const dayIn = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: slip.platform.timezone, day: "2-digit", month: "short", year: "numeric",
    }).format(d);

  doc.lineWidth(0.8).strokeColor(INK);
  const hline = (y: number, x1 = LEFT, x2 = RIGHT) => doc.moveTo(x1, y).lineTo(x2, y).stroke();
  const vline = (x: number, y1: number, y2: number) => doc.moveTo(x, y1).lineTo(x, y2).stroke();

  // Text centred vertically inside a row of height h that starts at top.
  function cell(
    text: string, x: number, top: number, h: number, w: number,
    opts: { bold?: boolean; align?: "left" | "center" | "right"; size?: number } = {},
  ) {
    const size = opts.size ?? 9;
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(INK);
    doc.text(text, x + 6, top + (h - size) / 2, { width: w - 12, align: opts.align ?? "left", lineBreak: false });
  }

  // --- logo, above the box as on the company's own slip
  const logo = LOGOS[slip.platform.slug];
  let y = 40;
  if (logo) {
    doc.image(logo, LEFT, 36, { height: 48 });
    y = 94;
  }

  // --- title box
  const titleH = 70;
  doc.rect(LEFT, y, W, titleH).stroke();
  doc.font("Times-Bold").fontSize(15).fillColor(INK);
  doc.text(slip.platform.name, LEFT, y + 14, { width: W, align: "center" });
  doc.font("Times-Bold").fontSize(11);
  doc.text(`Pay slip for the month of ${monthLabel}`, LEFT, y + 46, { width: W, align: "center" });
  if (slip.status !== "APPROVED") {
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#b91c1c");
    doc.text(`${slip.status} - NOT APPROVED`, RIGHT - 160, y + 5, { width: 154, align: "right", lineBreak: false });
  }
  y += titleH;

  // --- employee details: labels in bold, values beside them
  const detailsH = 112;
  const split = LEFT + W * 0.64;
  doc.rect(LEFT, y, W, detailsH).stroke();
  vline(split, y, y + detailsH);
  const dept = slip.user.teamMemberships[0]?.team.name ?? "-";
  const leftRows: [string, string][] = [
    ["Employee Name:", name],
    ["Employee Code:", slip.user.employeeCode ?? "-"],
    ["Department:", dept],
    ["Designation:", slip.user.designation ?? "-"],
  ];
  const rightRows: [string, string][] = [
    ["Date Of Joining:", slip.user.dateOfJoining ? dayIn(slip.user.dateOfJoining) : "-"],
    // PAN is not collected anywhere in the system yet, so it is left as a dash
    // rather than invented.
    ["PAN No:", "-"],
    ["Paid Days:", dayCount(payableDays)],
    ["Leaves Applied:", dayCount(attendance.totals.leaveDays)],
  ];
  const rowH = detailsH / 4;
  leftRows.forEach(([label, value], i) => {
    const top = y + i * rowH;
    cell(label, LEFT, top, rowH, 110, { bold: true });
    cell(value, LEFT + 110, top, rowH, split - LEFT - 110);
  });
  rightRows.forEach(([label, value], i) => {
    const top = y + i * rowH;
    cell(label, split, top, rowH, 95, { bold: true });
    cell(value, split + 95, top, rowH, RIGHT - split - 95);
  });
  y += detailsH;

  // --- earnings | deductions
  const dividerX = LEFT + W * 0.71;
  const eW = dividerX - LEFT;
  const cols = [0, 0.2, 0.43, 0.65, 0.78, 1].map((f) => LEFT + eW * f);
  const earned = Math.round((gross - lossOfPay) * 100) / 100;

  const headH = 28;
  const bodyRows = otherDeduction > 0 ? 2 : 1;
  const bodyH = bodyRows * 22 + 14;

  doc.rect(LEFT, y, W, headH + bodyH).stroke();
  vline(dividerX, y, y + headH + bodyH);
  hline(y + headH);

  const heads = ["Earnings", "Monthly Rate", "Current Month", "Arrears", "Total"];
  heads.forEach((h, i) =>
    cell(h, cols[i], y, headH, cols[i + 1] - cols[i], { bold: true, align: "center" }),
  );
  const dedW = (RIGHT - dividerX) * 0.6;
  const amtW = (RIGHT - dividerX) * 0.4;
  cell("Deductions", dividerX, y, headH, dedW, { bold: true, align: "center" });
  cell("Amount", dividerX + dedW, y, headH, amtW, { bold: true, align: "right" });

  // Pay is pro-rated for paid days: Current Month is what the person earned
  // this month, so the loss of pay is already inside it. Net = earned less any
  // manual deduction, which is the same net the approval screen shows.
  const bodyTop = y + headH + 4;
  cell("Basic Salary", cols[0], bodyTop, 22, cols[1] - cols[0]);
  cell(inr(gross), cols[1], bodyTop, 22, cols[2] - cols[1], { align: "center" });
  cell(inr(earned), cols[2], bodyTop, 22, cols[3] - cols[2], { align: "center" });
  cell("0", cols[3], bodyTop, 22, cols[4] - cols[3], { align: "center" });
  cell(inr(earned), cols[4], bodyTop, 22, cols[5] - cols[4], { align: "center" });

  if (otherDeduction > 0) {
    cell(slip.otherDeductionNote ? `Other (${slip.otherDeductionNote})` : "Other deduction",
      dividerX, bodyTop, 22, dedW);
    cell(inr(otherDeduction), dividerX + dedW, bodyTop, 22, amtW, { align: "right" });
  }
  const tdTop = bodyTop + (otherDeduction > 0 ? 22 : 0);
  cell("Total Deductions", dividerX, tdTop, 22, dedW);
  cell(inr(otherDeduction), dividerX + dedW, tdTop, 22, amtW, { align: "right" });
  y += headH + bodyH;

  // --- gross earnings | net salary
  const totH = 36;
  doc.rect(LEFT, y, W, totH).stroke();
  vline(dividerX, y, y + totH);
  cell("Gross Earnings", cols[0], y, totH, cols[3] - cols[0], { align: "center" });
  cell(inr(earned), cols[4], y, totH, cols[5] - cols[4], { align: "center", bold: true });
  cell("Net Salary", dividerX, y, totH, dedW);
  cell(inr(net), dividerX + dedW, y, totH, amtW, { align: "right", bold: true });
  y += totH;

  // --- in words
  const wordsH = 36;
  doc.rect(LEFT, y, W, wordsH).stroke();
  cell("In words:", LEFT, y, wordsH, 60, { bold: true });
  cell(amountInWords(net), LEFT + 56, y, wordsH, W - 56);
  y += wordsH;

  // --- disclaimer
  const discH = 22;
  doc.rect(LEFT, y, W, discH).stroke();
  cell(
    "Disclaimer - This is computer generated salary slip, does not require any signature.",
    LEFT, y, discH, W, { align: "center", size: 7 },
  );
  y += discH + 12;

  // --- how it was worked out, outside the box
  doc.font("Helvetica").fontSize(8).fillColor("#475569");
  doc.text(
    `Basic salary is pro-rated: ${dayCount(payableDays)} paid days of ${daysInMonth} ` +
      `(${money(perDay)} per day). Loss of pay for the remaining days: ${money(lossOfPay)}. ` +
      `No PF, PT or ESI is deducted. Generated ${dayIn(new Date())}` +
      (slip.approvedAt ? `, approved ${dayIn(slip.approvedAt)}.` : ", not yet approved."),
    LEFT, y, { width: W },
  );

  doc.end();
  const pdf = await finished;

  const safeCode = (slip.user.employeeCode ?? "employee").replace(/[^A-Za-z0-9-]/g, "");
  const fileName = `payslip-${safeCode}-${slip.year}-${String(slip.month).padStart(2, "0")}.pdf`;

  return { pdf, fileName };
}