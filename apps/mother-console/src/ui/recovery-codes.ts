/**
 * Recovery codes leave the console only as the owner chooses (D-703): copied, saved as a
 * text file, or printed from a page of their own that holds nothing else.
 */

export function downloadCodes(codes: readonly string[]): void {
  const blob = new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'recovery-codes.txt';
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Print the codes alone: a blank page of this origin with the title and a list, built with
 * DOM calls (no markup string, no script), printed, then closed.
 */
export function printCodes(codes: readonly string[], title: string): void {
  const page = window.open('', '_blank', 'width=480,height=640');
  if (page === null) return;
  const { document: doc } = page;
  doc.title = title;
  const heading = doc.createElement('h1');
  heading.textContent = title;
  const list = doc.createElement('pre');
  list.textContent = codes.join('\n');
  doc.body.append(heading, list);
  page.focus();
  page.print();
  page.close();
}

export function copyCodes(codes: readonly string[]): Promise<void> {
  return navigator.clipboard.writeText(codes.join('\n'));
}
