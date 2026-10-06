import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

export async function getPdfPageCount(arrayBuffer) {
  try {
    const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
    return pdfDoc.getPageCount();
  } catch (err) {
    console.error("Error reading PDF", err);
    throw new Error("Invalid PDF");
  }
}

export async function generatePackage({ tender, requirements, matchedFiles, language }) {
  const mergedPdf = await PDFDocument.create();
  const font = await mergedPdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await mergedPdf.embedFont(StandardFonts.HelveticaBold);
  
  // 1. Create cover page
  const coverPage = mergedPdf.addPage();
  const { width, height } = coverPage.getSize();
  
  let y = height - 50;
  
  const drawText = (text, size, isBold = false) => {
    coverPage.drawText(text, {
      x: 50,
      y,
      size,
      font: isBold ? boldFont : font,
      color: rgb(0, 0, 0),
    });
    y -= (size + 10);
  };
  
  drawText('TENDER DOCUMENT PACKAGE', 24, true);
  y -= 20;
  
  drawText(`Tender ID: ${tender.tender_id}`, 14, true);
  drawText(`Title: ${tender.title}`, 14);
  drawText(`Procuring Entity: ${tender.procuring_entity}`, 14);
  drawText(`Bidder: ${tender.bidder}`, 14);
  drawText(`Submission Deadline: ${tender.submission_deadline}`, 14);
  drawText(`Generated On: ${new Date().toLocaleDateString('en-CA')}`, 14);
  
  y -= 30;
  drawText('Included Documents:', 16, true);
  
  const sortedReqs = [...requirements].sort((a, b) => a.order - b.order);
  const includedDocs = [];
  
  for (const req of sortedReqs) {
    const match = matchedFiles.find(m => m.requirementId === req.id);
    if (match) {
      includedDocs.push({
        title: req.title_en,
        fileId: match.fileId
      });
      drawText(`${req.order}. ${req.title_en}`, 12);
    }
  }

  // 2. Load and append all matched PDFs
  for (const doc of includedDocs) {
    const fileObj = matchedFiles.find(m => m.fileId === doc.fileId)?.fileObj;
    if (fileObj) {
      const srcPdf = await PDFDocument.load(fileObj.arrayBuffer, { ignoreEncryption: true });
      const copiedPages = await mergedPdf.copyPages(srcPdf, srcPdf.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }
  }
  
  // 3. Add footer to every page
  const totalPages = mergedPdf.getPageCount();
  for (let i = 0; i < totalPages; i++) {
    const page = mergedPdf.getPage(i);
    const { width } = page.getSize();
    const footerText = `${tender.tender_id} | Page ${i + 1} of ${totalPages}`;
    const textWidth = font.widthOfTextAtSize(footerText, 10);
    
    page.drawText(footerText, {
      x: width / 2 - textWidth / 2,
      y: 20,
      size: 10,
      font: font,
      color: rgb(0, 0, 0),
    });
  }
  
  // 4. Export
  const pdfBytes = await mergedPdf.save();
  return pdfBytes;
}
