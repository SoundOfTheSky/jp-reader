export type YomitanTokenizerResult = {
  id: string
  source: string
  dictionary: unknown
  index: number
  content: YomitanTokenizerItem[][]
}[]

export type YomitanTokenizerItem = {
  text: string
  reading: string
  headwords?: YomitanTokenizerHeadword[][]
}

export type YomitanTokenizerHeadword = {
  term: string
  reading: string
  sources: {
    deinflectedText: string
    isPrimary: boolean
    matchSource: string
    matchType: string
    originalText: string
    transformedText: string
  }[]
  frequencies?: {
    index: number
    headwordIndex: number
    dictionary: string
    dictionaryIndex: number
    dictionaryAlias: string
    hasReading: boolean
    frequencyMode: string
    frequency: number
    displayValue: string
    displayValueParsed: boolean
  }[]
}

export type TokenizeResult = {
  text: string
  position: number
  pitch?: number
  furigana?: {
    text: string
    start: number
    end: number
  }
  interval?: number
}

export enum FuriganaMode {
  NONE = 0,
  HIRAGANA = 1,
  KATAKANA = 2,
  ROMAJI = 3,
}

export type SyncStorage = {
  enabled: boolean
  ankiUrl: string
  ankiQuery: string
  ankiExpressionField: string
  ankiKanjiQuery: string
  ankiKanjiField: string
  ankiEnabled: boolean
  ankiKanjiEnabled: boolean
  furigana: FuriganaMode
}

export type KanjiIntervals = Map<string, number> | undefined

/** Get kanji intervals */
export function getKanjiIntervals(): Promise<KanjiIntervals> {
  return chrome.runtime.sendMessage({
    type: 'getKanjiIntervals',
  })
}

/** Run tokenizer */
export function tokenize(text: string): Promise<TokenizeResult[]> {
  return chrome.runtime.sendMessage({
    type: 'tokenize',
    text,
  })
}

/** Check connection to services */
export function checkConnection(): Promise<boolean> {
  return chrome.runtime.sendMessage({
    type: 'checkConnection',
  })
}

/** Get data from storage */
export function storageGet<T extends keyof SyncStorage>(
  keys: T[],
): Promise<Pick<SyncStorage, T>> {
  return chrome.runtime.sendMessage({
    type: 'storageGet',
    keys,
  })
}

/** Set data to storage */
export function storageSet(data: Partial<SyncStorage>) {
  return chrome.runtime.sendMessage({
    type: 'storageSet',
    data,
  })
}

/** Request with timeout and auto json */
export function request<T>(
  resource: string,
  options: RequestInit = {},
  ms = 15000,
): Promise<T> {
  const controller = new AbortController()
  const id = setTimeout(() => {
    controller.abort()
  }, ms)
  return fetch(resource, { signal: controller.signal, ...options })
    .then((x) => x.json())
    .finally(() => {
      clearTimeout(id)
    })
}
