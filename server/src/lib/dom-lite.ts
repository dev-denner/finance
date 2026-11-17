/**
 * Tipos mínimos do DOM para o código que roda dentro do Chromium
 * (`page.evaluate`) ou recebe um documento do jsdom nos testes.
 *
 * O server compila sem `lib: DOM`, para que `document` e `window` não pareçam
 * existir no backend. Uma diretiva `/// <reference lib="dom" />` ligaria o DOM
 * no programa inteiro; estas interfaces estruturais ficam restritas a quem as
 * importa e são compatíveis com o DOM real e com o jsdom.
 */
export interface DomElement {
  textContent: string | null;
  innerText?: string;
  parentElement: DomElement | null;
  nextElementSibling: DomElement | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  getAttribute(name: string): string | null;
  getElementsByTagName(qualifiedName: string): ArrayLike<DomElement>;
  getElementsByTagNameNS(namespace: string | null, localName: string): ArrayLike<DomElement>;
}

export interface DomTableRow extends DomElement {
  cells: ArrayLike<DomElement>;
}

export interface DomDocument {
  body: { innerText: string } | null;
  documentElement: { outerHTML: string };
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
  getElementsByTagName(qualifiedName: string): ArrayLike<DomElement>;
  getElementsByTagNameNS(namespace: string | null, localName: string): ArrayLike<DomElement>;
}

export interface DomParserConstructor {
  new (): { parseFromString(source: string, mimeType: string): DomDocument };
}
