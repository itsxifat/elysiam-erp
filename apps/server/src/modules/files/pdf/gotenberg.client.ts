/**
 * The Gotenberg client (architecture §22, §21).
 *
 * Gotenberg is headless Chromium behind an HTTP API. It is used instead of a
 * PDF library because §22's real requirement is Bangla: a library that draws
 * text box by box does not run the font's GSUB table, so `ক্ষ` comes out as
 * three separate letters. Chromium shapes it because Chromium is a browser.
 *
 * ## What was verified, and how
 *
 * Against the running `gotenberg/gotenberg:8.37` from
 * `infra/docker-compose.dev.yml`, not against documentation alone:
 *
 * - `POST /forms/chromium/convert/html` with a multipart `files` part named
 *   `index.html` returns `application/pdf`.
 * - `POST /forms/chromium/screenshot/html`, same shape plus `format=png`,
 *   returns `image/png`.
 * - Extra `files` parts land beside `index.html` in Chromium's working
 *   directory, so a plain relative `url('font.woff2')` resolves — which is the
 *   only way fonts can load, because that container runs with
 *   `--chromium-allow-list=file:///tmp/.*` and therefore cannot fetch anything
 *   from the network.
 *
 * That last constraint is a feature and this client is written to live inside
 * it: every asset a document needs is uploaded with it, and a template that
 * referenced a remote URL would simply render without it rather than failing.
 */

export interface GotenbergAsset {
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface RenderRequest {
  /** The document, which Gotenberg requires to be called `index.html`. */
  readonly html: string;
  /** Fonts, images, stylesheets — anything the HTML references relatively. */
  readonly assets?: readonly GotenbergAsset[];
  /** Inches. A4 is 8.27 × 11.7; the default here. */
  readonly paperWidth?: number;
  readonly paperHeight?: number;
  readonly marginInches?: number;
  /** Milliseconds before the request is abandoned. */
  readonly timeoutMs?: number;
}

export interface ScreenshotRequest extends RenderRequest {
  /** CSS pixels. The viewport, not the image's final width in every case. */
  readonly width?: number;
  readonly height?: number;
  readonly fullPage?: boolean;
}

export class GotenbergError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GotenbergError';
  }
}

export class GotenbergClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private form(request: RenderRequest): FormData {
    const form = new FormData();
    // The name of the part is `files` for every file; the *filename* is what
    // Gotenberg keys on, and `index.html` is the one it looks for.
    form.append(
      'files',
      new Blob([request.html], { type: 'text/html; charset=utf-8' }),
      'index.html',
    );
    for (const asset of request.assets ?? []) {
      form.append(
        'files',
        // A fresh ArrayBuffer rather than the view: a Uint8Array over a larger
        // pooled buffer (which `Buffer.from(await readFile())` can be) would
        // otherwise be sent in full, corrupting the file with whatever else
        // shares that pool.
        new Blob([asset.bytes.slice().buffer], { type: asset.contentType }),
        asset.filename,
      );
    }
    return form;
  }

  private async post(path: string, form: FormData, timeoutMs: number): Promise<Uint8Array> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      body: form,
      // A renderer that hangs holds a worker; Gotenberg's own default trace
      // timeout is 30s, so ours has to be at least as generous or we abandon
      // work it is still doing and retry it, doubling the load.
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      // Gotenberg's error body is a short plain-text reason and contains
      // nothing but our own input, so it is safe to surface — and it is the
      // difference between "500" and "index.html is required".
      const reason = (await response.text()).slice(0, 500);
      throw new GotenbergError(response.status, `Gotenberg refused the render: ${reason}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  /** Render a document to PDF. */
  async renderPdf(request: RenderRequest): Promise<Uint8Array> {
    const form = this.form(request);
    form.append('paperWidth', String(request.paperWidth ?? 8.27));
    form.append('paperHeight', String(request.paperHeight ?? 11.7));
    const margin = String(request.marginInches ?? 0.4);
    for (const side of ['Top', 'Bottom', 'Left', 'Right']) {
      form.append(`margin${side}`, margin);
    }
    // Backgrounds off would drop the table's header fill and the hairlines that
    // separate its rows, which is most of what makes a document readable.
    form.append('printBackground', 'true');
    return this.post('/forms/chromium/convert/html', form, request.timeoutMs ?? 30_000);
  }

  /**
   * Rasterize a document to PNG.
   *
   * Used for the human-checkable Bangla proof (acceptance check 5). It renders
   * the same HTML through the same Chromium with the same fonts as `renderPdf`,
   * so what it shows is what the PDF contains — which is the property that
   * makes it evidence rather than decoration.
   */
  async screenshotPng(request: ScreenshotRequest): Promise<Uint8Array> {
    const form = this.form(request);
    form.append('format', 'png');
    /*
     * 794 × 1123 CSS pixels is A4 at 96 DPI, which is what Chromium prints at.
     * Sizing the viewport to a page rather than taking a default-height
     * screenshot is what makes the image *page 1* rather than "the top of the
     * document" — the first version clipped the invoice footer, so the one
     * part a reviewer would check last was the part not in the picture.
     */
    form.append('width', String(request.width ?? 794));
    form.append('height', String(request.height ?? 1123));
    form.append('fullPage', String(request.fullPage ?? false));
    form.append('optimizeForSpeed', 'false');
    return this.post('/forms/chromium/screenshot/html', form, request.timeoutMs ?? 30_000);
  }

  /** Whether Gotenberg is up. Used by tests to skip rather than fail blind. */
  async isReady(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
