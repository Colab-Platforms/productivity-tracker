// Real (native, editable) Excel charts for the dashboard workbook.
//
// exceljs cannot draw charts, so this module writes the chart definitions (DrawingML) itself and adds them to the .xlsx file after exceljs has
// produced it. An .xlsx is a zip of XML parts; a chart needs four of them:
//   xl/charts/chartN.xml                 the chart itself (series point at cell ranges of the sheet, so it follows the table, filters included)
//   xl/drawings/drawingN.xml             where on the sheet each chart sits
//   xl/drawings/_rels/drawingN.xml.rels  which chart file each placement uses
//   + a <drawing> link in the sheet's XML, its relationship, and the content types of the new parts.
// Every series also carries a cached copy of its values, so a viewer that does not recalculate (a preview, a phone) still draws the chart.
// This module is pure (no browser, no network) so the XML can be tested on its own. JSZip is the library exceljs itself uses for the zip.

export type ChartSeries = {
  name: string; // the series name shown in the legend
  nameRef: string; // the header cell holding that name, e.g. 'Dashboard'!$I$20
  catRef: string; // the employee names, e.g. 'Dashboard'!$A$21:$A$90
  valRef: string; // the numbers, e.g. 'Dashboard'!$I$21:$I$90
  categories: string[]; // cached copy of the names
  values: (number | null)[]; // cached copy of the numbers; null = nothing recorded (a gap, never a zero)
  color: string; // RRGGBB
};
export type ChartSpec = {
  title: string;
  stacked: boolean;
  series: ChartSeries[];
  categoryTitle: string; // the axis that lists employees
  valueTitle: string; // the axis with the numbers (with its unit)
  valueMax?: number; // fixed top of the number axis (e.g. 5 for star ratings)
  // where the chart sits: 0-based column / row of its top-left corner, and the column / row where it ends
  anchor: { fromCol: number; fromRow: number; toCol: number; toRow: number };
};

const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const REL_CHART = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
const REL_DRAWING = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
const CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
const CT_DRAWING = "application/vnd.openxmlformats-officedocument.drawing+xml";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Escapes text for an XML element or attribute. Also removes characters XML cannot hold at all. */
export function esc(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const strCache = (values: string[]) => `<c:strCache><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("")}</c:strCache>`;
// A missing value has no <c:pt>: Excel draws a gap for it (dispBlanksAs = gap), it is never drawn as zero.
const numCache = (values: (number | null)[]) =>
  `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values.map((v, i) => (v === null || !Number.isFinite(v) ? "" : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join("")}</c:numCache>`;

function titleXml(text: string, size: number, bold: boolean, vertical = false): string {
  const rot = vertical ? ' rot="-5400000" vert="horz"' : "";
  return (
    `<c:title><c:tx><c:rich><a:bodyPr${rot}/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="${bold ? 1 : 0}"/></a:pPr>` +
    `<a:r><a:rPr lang="en-US" sz="${size}" b="${bold ? 1 : 0}"/><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`
  );
}

function seriesXml(s: ChartSeries, i: number): string {
  return (
    `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>` +
    `<c:tx><c:strRef><c:f>${esc(s.nameRef)}</c:f>${strCache([s.name])}</c:strRef></c:tx>` +
    `<c:spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>` +
    `<c:cat><c:strRef><c:f>${esc(s.catRef)}</c:f>${strCache(s.categories)}</c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>${esc(s.valRef)}</c:f>${numCache(s.values)}</c:numRef></c:val></c:ser>`
  );
}

/** One horizontal bar chart (clustered or stacked). Element order follows the OOXML schema exactly: Excel is strict about it. */
export function chartXml(spec: ChartSpec): string {
  const CAT = 50010;
  const VAL = 50020;
  const max = spec.valueMax !== undefined ? `<c:max val="${spec.valueMax}"/><c:min val="0"/>` : "";
  return (
    XML_HEAD +
    `<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:date1904 val="0"/><c:roundedCorners val="0"/><c:chart>` +
    titleXml(spec.title, 1300, true) +
    `<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>` +
    `<c:barChart><c:barDir val="bar"/><c:grouping val="${spec.stacked ? "stacked" : "clustered"}"/><c:varyColors val="0"/>` +
    spec.series.map(seriesXml).join("") +
    `<c:gapWidth val="${spec.stacked ? 40 : 50}"/>${spec.stacked ? '<c:overlap val="100"/>' : ""}<c:axId val="${CAT}"/><c:axId val="${VAL}"/></c:barChart>` +
    // employees run down the left, first employee on top (maxMin), so the number axis is put back at the bottom with crosses = max
    `<c:catAx><c:axId val="${CAT}"/><c:scaling><c:orientation val="maxMin"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>` +
    titleXml(spec.categoryTitle, 1000, false, true) +
    `<c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>` +
    `<c:crossAx val="${VAL}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:tickLblSkip val="1"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    `<c:valAx><c:axId val="${VAL}"/><c:scaling><c:orientation val="minMax"/>${max}</c:scaling><c:delete val="0"/><c:axPos val="b"/>` +
    `<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="D9DCF0"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>` +
    titleXml(spec.valueTitle, 1000, false) +
    `<c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>` +
    `<c:crossAx val="${CAT}"/><c:crosses val="max"/><c:crossBetween val="between"/></c:valAx>` +
    `</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    `<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="D9DCF0"/></a:solidFill></a:ln></c:spPr>` +
    `</c:chartSpace>`
  );
}

/** The sheet drawing: one anchored frame per chart; chart i uses relationship rId{i+1}. */
export function drawingXml(charts: ChartSpec[]): string {
  const anchors = charts
    .map((c, i) => {
      const a = c.anchor;
      return (
        `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${a.fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
        `<xdr:to><xdr:col>${a.toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
        `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
        `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" xmlns:r="${NS_R}" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
      );
    })
    .join("");
  return XML_HEAD + `<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">${anchors}</xdr:wsDr>`;
}

const relsXml = (items: { id: string; type: string; target: string }[]) =>
  XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join("")}</Relationships>`;

// Names are unusual on purpose so they can never collide with a part exceljs wrote itself.
const DRAWING_NO = 901;
const CHART_NO = 901;

/**
 * Adds the charts to sheet `sheetFile` (e.g. "sheet1.xml") of an .xlsx produced by exceljs and returns the new file.
 * Everything exceljs wrote stays exactly as it was; the only edits are the new parts, one <drawing> element in that sheet, its relationship,
 * and the content-type entries.
 */
export async function addChartsToWorkbook(file: ArrayBuffer | Uint8Array, sheetFile: string, charts: ChartSpec[]): Promise<ArrayBuffer> {
  if (charts.length === 0) return file instanceof Uint8Array ? (file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer) : file;
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(file);

  charts.forEach((c, i) => zip.file(`xl/charts/chart${CHART_NO + i}.xml`, chartXml(c)));
  zip.file(`xl/drawings/drawing${DRAWING_NO}.xml`, drawingXml(charts));
  zip.file(`xl/drawings/_rels/drawing${DRAWING_NO}.xml.rels`, relsXml(charts.map((_, i) => ({ id: `rId${i + 1}`, type: REL_CHART, target: `../charts/chart${CHART_NO + i}.xml` }))));

  // the sheet: declare the r: prefix if needed, then one <drawing r:id> at the place the schema wants it
  const sheetPath = `xl/worksheets/${sheetFile}`;
  const sheetEntry = zip.file(sheetPath);
  if (!sheetEntry) throw new Error(`The sheet ${sheetFile} is not in the workbook.`);
  let sheet = await sheetEntry.async("string");
  const relId = "rIdCharts1";
  if (!/<worksheet\b[^>]*\bxmlns:r=/.test(sheet)) sheet = sheet.replace(/<worksheet\b/, `<worksheet xmlns:r="${NS_R}"`);
  // CT_Worksheet order: ... pageMargins, pageSetup, headerFooter, ..., drawing, legacyDrawing, ..., tableParts, extLst
  const before = ["<legacyDrawing", "<legacyDrawingHF", "<picture", "<oleObjects", "<controls", "<webPublishItems", "<tableParts", "<extLst", "</worksheet>"];
  let at = -1;
  for (const tag of before) {
    const i = sheet.indexOf(tag);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  sheet = sheet.slice(0, at) + `<drawing r:id="${relId}"/>` + sheet.slice(at);
  zip.file(sheetPath, sheet);

  const relsPath = `xl/worksheets/_rels/${sheetFile}.rels`;
  const existing = zip.file(relsPath);
  const newRel = `<Relationship Id="${relId}" Type="${REL_DRAWING}" Target="../drawings/drawing${DRAWING_NO}.xml"/>`;
  if (existing) {
    const xml = await existing.async("string");
    zip.file(relsPath, xml.replace("</Relationships>", `${newRel}</Relationships>`));
  } else {
    zip.file(relsPath, XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${newRel}</Relationships>`);
  }

  const ctEntry = zip.file("[Content_Types].xml");
  if (!ctEntry) throw new Error("The workbook has no content types.");
  const overrides =
    `<Override PartName="/xl/drawings/drawing${DRAWING_NO}.xml" ContentType="${CT_DRAWING}"/>` +
    charts.map((_, i) => `<Override PartName="/xl/charts/chart${CHART_NO + i}.xml" ContentType="${CT_CHART}"/>`).join("");
  zip.file("[Content_Types].xml", (await ctEntry.async("string")).replace("</Types>", `${overrides}</Types>`));

  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}
