import { Semaphore } from '@softsky/utils'
import __wbg_init, {
  Tokenizer,
  TokenizerBuilder,
  loadDictionaryFromBytes,
} from 'lindera-wasm-web'
import {
  downloadDictionary,
  listDictionaries,
  loadDictionaryFiles,
  removeDictionary,
} from 'lindera-wasm-web/opfs'

import { kanaToRomaji, katakanaToHiragana } from './japanese'
import { FuriganaMode, request, SyncStorage, TokenizeResult } from './shared'

type Message =
  | TokenizeMessage
  | CheckConnectionMessage
  | StorageGetMessage
  | StorageSetMessage
  | GetKanjiIntervalsMessage
type TokenizeMessage = {
  type: 'tokenize'
  text: string
}
type CheckConnectionMessage = {
  type: 'checkConnection'
}
type StorageGetMessage = {
  type: 'storageGet'
}
type StorageSetMessage = {
  type: 'storageSet'
  data: Partial<SyncStorage>
}
type GetKanjiIntervalsMessage = {
  type: 'getKanjiIntervals'
}

const DICT_NAME = 'lindera-unidic-3.0.6'
const DICT_DETAILS_READING = 9
const DICT_DETAILS_BASE_FORM = 10
const ankiIntervals = new Map<string, number>()
const ankiKanjiIntervals = new Map<string, number>()
const pitch = new Map<string, number>()
const ankiSemaphore = new Semaphore(1)
const encoder = new TextEncoder()
let lastAnkiIntervalsUpdate = 0
let ankiAvailable = false
let ankiKanjiAvailable = false
let storage: SyncStorage
let tokenizer: Tokenizer
const initPromise = initialize()

chrome.runtime.onMessage.addListener(async (message: Message) => {
  // Wait for initialization
  await initPromise
  switch (message.type) {
    case 'tokenize':
      return tokenize(message.text)
    case 'checkConnection':
      return checkConnection()
    case 'storageGet':
      return chrome.storage.sync.get()
    case 'storageSet':
      return storageSet(message.data)
    case 'getKanjiIntervals':
      return getKanjiIntervals()
  }
})

async function getKanjiIntervals() {
  await updateAnkiIntervals()
  if (ankiKanjiAvailable) return ankiKanjiIntervals
}

/** Run tokenizer */
async function tokenize(text: string): Promise<TokenizeResult[]> {
  await updateAnkiIntervals()

  // It's insane how bad it is. I need to find a better way. Easily eats a few megabytes of memory for long texts.
  const byteToIndexMap: number[] = []
  let byteOffset = 0
  for (let index = 0; index < text.length; index++) {
    const bytes = encoder.encode(text[index]).length
    for (let i = 0; i < bytes; i++) byteToIndexMap[byteOffset + i] = index
    byteOffset += bytes
  }

  return tokenizer.tokenize(text).map((token) => {
    const tokenSurface = token.surface
    const result: TokenizeResult = {
      text: tokenSurface,
      position: byteToIndexMap[token.byte_start]!,
    }
    const tokenBaseForm = token.details[DICT_DETAILS_BASE_FORM]!
    /**
     * Convert reading to furigana.
     * Strip out common parts between reading and text at the start and the end.
     */
    if (storage.furigana !== FuriganaMode.NONE) {
      const tokenDetailsReading = token.details[DICT_DETAILS_READING]!
      let textReading = tokenSurface
      let tokenReading = tokenDetailsReading
      if (storage.furigana === FuriganaMode.HIRAGANA) {
        textReading = katakanaToHiragana(textReading)
        tokenReading = katakanaToHiragana(tokenReading)
      } else if (storage.furigana === FuriganaMode.ROMAJI) {
        textReading = kanaToRomaji(textReading)
        tokenReading = kanaToRomaji(tokenReading)
      }
      const l = tokenReading.length
      let startIndex = 0
      let endIndex = l - 1
      let textEndIndex = textReading.length - 1
      for (; startIndex < l; startIndex++)
        if (tokenReading[startIndex] !== textReading[startIndex]) break
      for (; endIndex !== -1; endIndex--, textEndIndex--)
        if (tokenReading[endIndex] !== textReading[textEndIndex]) break
      if (startIndex < endIndex)
        result.furigana = {
          text: tokenReading.slice(startIndex, endIndex + 1),
          start: startIndex,
          end: textEndIndex + 1,
        }
    }

    if (ankiAvailable) result.interval = ankiIntervals.get(tokenBaseForm) ?? -1

    const pitchAccent = pitch.get(tokenBaseForm)
    if (pitchAccent !== undefined) result.pitch = pitchAccent
    return result
  })
}

/** Make request to AnkiConnect */
async function ankiRequest<T>(body: any, ankiUrl: string): Promise<T> {
  const json = await request<{
    result: T
    error: string | null
  }>(ankiUrl, {
    method: 'POST',
    body: JSON.stringify({
      version: 6,
      ...body,
    }),
  })
  if (json.error) throw new Error(json.error)
  return json.result
}

/** Check if we are connected */
async function checkConnection(): Promise<boolean> {
  try {
    const anki = await request<{ apiVersion: 'AnkiConnect v.6' }>(
      storage.ankiUrl,
      {
        method: 'POST',
      },
    )
    lastAnkiIntervalsUpdate = 0
    await updateAnkiIntervals()
    return +anki.apiVersion.replace(/[^0-9]/g, '') >= 6
  } catch {
    return false
  }
}

/** Update the Anki intervals map. Cooldown 1 minute */
async function updateAnkiIntervals() {
  // Prevent multiple simultaneous updates
  await ankiSemaphore.acquire()
  try {
    const now = Date.now()
    // Cooldown
    if (now - lastAnkiIntervalsUpdate < 60000) return
    if (
      storage.ankiQuery &&
      storage.ankiExpressionField &&
      storage.ankiEnabled
    ) {
      try {
        const cards = await ankiRequest<
          { interval: number; fields: Record<string, { value: string }> }[]
        >(
          {
            action: 'cardsInfo',
            params: {
              cards: await ankiRequest<number[]>(
                {
                  action: 'findCards',
                  params: {
                    query: storage.ankiQuery,
                  },
                },
                storage.ankiUrl,
              ),
            },
          },
          storage.ankiUrl,
        )
        ankiIntervals.clear()
        for (let index = 0; index < cards.length; index++) {
          const card = cards[index]!
          ankiIntervals.set(
            card.fields[storage.ankiExpressionField]!.value,
            card.interval,
          )
        }
        ankiAvailable = true
      } catch {
        ankiAvailable = false
      }
    } else ankiAvailable = false
    if (
      storage.ankiKanjiQuery &&
      storage.ankiKanjiField &&
      storage.ankiKanjiEnabled
    ) {
      try {
        const cards = await ankiRequest<
          { interval: number; fields: Record<string, { value: string }> }[]
        >(
          {
            action: 'cardsInfo',
            params: {
              cards: await ankiRequest<number[]>(
                {
                  action: 'findCards',
                  params: {
                    query: storage.ankiKanjiQuery,
                  },
                },
                storage.ankiUrl,
              ),
            },
          },
          storage.ankiUrl,
        )
        ankiKanjiIntervals.clear()
        for (let index = 0; index < cards.length; index++) {
          const card = cards[index]!
          ankiKanjiIntervals.set(
            card.fields[storage.ankiKanjiField]!.value,
            card.interval,
          )
        }
        ankiKanjiAvailable = true
      } catch {
        ankiKanjiAvailable = false
      }
    } else ankiKanjiAvailable = false
    lastAnkiIntervalsUpdate = now
  } finally {
    ankiSemaphore.release()
  }
}

/** Set data to storage */
async function storageSet(data: Partial<SyncStorage>) {
  Object.assign(storage, data)
  await chrome.storage.sync.set(data)
  const tabs = await chrome.tabs.query({})
  for (let index = 0; index < tabs.length; index++) {
    const id = tabs[index]!.id
    if (id !== undefined)
      void chrome.tabs.sendMessage(id, { type: 'storage', storage })
  }
}

async function initializeStorage() {
  const DEFAULT_DATA: SyncStorage = {
    ankiEnabled: true,
    ankiExpressionField: 'Expression',
    ankiKanjiEnabled: true,
    ankiKanjiField: 'Kanji',
    ankiKanjiQuery: '"note:JP Kanji"',
    ankiQuery: '"note:JP Vocab"',
    ankiUrl: 'http://127.0.0.1:8765',
    enabled: true,
    furigana: FuriganaMode.HIRAGANA,
  }
  storage = await chrome.storage.sync.get<SyncStorage>()
  for (const key in DEFAULT_DATA)
    if (
      typeof storage[key as keyof SyncStorage] !==
      typeof DEFAULT_DATA[key as keyof SyncStorage]
    )
      storage[key as 'enabled'] = DEFAULT_DATA[key as 'enabled']
  await chrome.storage.sync.set<SyncStorage>(storage)
}

async function initializePitchAccents() {
  const pitchText = await fetch(chrome.runtime.getURL('assets/accents.txt'))
    .then((res) => res.text())
    .then((text) => text.split('\n'))
  for (let index = 0; index < pitchText.length; index++) {
    const [kanji, hiragana, pitchValue] = pitchText[index]!.split('	')
    const pitchValueNumber = parseInt(pitchValue!)
    pitch.set(kanji!, pitchValueNumber)
    pitch.set(hiragana!, pitchValueNumber)
  }
}

async function initializeTokenizer() {
  await __wbg_init()
  const dictionaries = await listDictionaries()
  if (dictionaries.length !== 1 || dictionaries[0] !== DICT_NAME) {
    for (let index = 0; index < dictionaries.length; index++)
      await removeDictionary(dictionaries[index]!)
    await downloadDictionary(
      chrome.runtime.getURL(`assets/${DICT_NAME}.zip`),
      DICT_NAME,
    )
  }
  const files = await loadDictionaryFiles(DICT_NAME)
  const dict = loadDictionaryFromBytes(
    files.metadata,
    files.dictDa,
    files.dictVals,
    files.dictWordsIdx,
    files.dictWords,
    files.matrixMtx,
    files.charDef,
    files.unk,
  )
  const builder = new TokenizerBuilder()
  builder.setDictionaryInstance(dict)
  builder.setMode('normal')
  tokenizer = builder.build()
}

function initialize() {
  return Promise.all([
    initializeStorage(),
    initializePitchAccents(),
    initializeTokenizer(),
  ])
}
