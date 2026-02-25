import type { AxiosResponse, AxiosError } from 'axios';
import type { ContentType, ResponseHeaders, IHttpResponse } from './types';

/**
 * Wraps an axios response to match the JetBrains HTTP Client `response` object.
 *
 * API:
 *   response.status       – HTTP status code
 *   response.body         – parsed body (JSON object if applicable, otherwise string)
 *   response.headers.valueOf(name)   – single header value
 *   response.headers.valuesOf(name)  – array of header values
 *   response.contentType.mimeType    – content type string
 */
export class HttpResponse implements IHttpResponse {
  private _raw: AxiosResponse;

  public status: number;
  public body: unknown;
  public contentType: ContentType;
  public headers: ResponseHeaders;

  constructor(axiosResponse: AxiosResponse) {
    this._raw = axiosResponse;

    this.status = axiosResponse.status;
    this.body = axiosResponse.data;

    const ct = (axiosResponse.headers['content-type'] as string) || '';
    this.contentType = {
      mimeType: ct.split(';')[0].trim(),
      charset: HttpResponse._extractCharset(ct),
    };

    this.headers = {
      valueOf: (name: string): string | null => {
        const val = axiosResponse.headers[name.toLowerCase()];
        if (Array.isArray(val)) return val[0];
        return (val as string) || null;
      },
      valuesOf: (name: string): string[] => {
        const val = axiosResponse.headers[name.toLowerCase()];
        if (val == null) return [];
        return Array.isArray(val) ? val : [val as string];
      },
    };
  }

  static _extractCharset(contentType: string): string | null {
    const match = contentType.match(/charset=([^\s;]+)/i);
    return match ? match[1] : null;
  }
}

/**
 * Wraps an axios error into a response-like object so handlers can still run.
 */
export class HttpErrorResponse implements IHttpResponse {
  private _error: AxiosError;

  public status: number;
  public body: unknown;
  public contentType: ContentType;
  public headers: ResponseHeaders;

  constructor(error: AxiosError) {
    this._error = error;

    if (error.response) {
      this.status = error.response.status;
      this.body = error.response.data;
      const ct = (error.response.headers['content-type'] as string) || '';
      this.contentType = {
        mimeType: ct.split(';')[0].trim(),
        charset: HttpResponse._extractCharset(ct),
      };
      this.headers = {
        valueOf: (name: string): string | null => {
          const val = error.response!.headers[name.toLowerCase()];
          if (Array.isArray(val)) return val[0];
          return (val as string) || null;
        },
        valuesOf: (name: string): string[] => {
          const val = error.response!.headers[name.toLowerCase()];
          if (val == null) return [];
          return Array.isArray(val) ? val : [val as string];
        },
      };
    } else {
      this.status = 0;
      this.body = null;
      this.contentType = { mimeType: '', charset: null };
      this.headers = {
        valueOf: (): null => null,
        valuesOf: (): string[] => [],
      };
    }
  }
}
