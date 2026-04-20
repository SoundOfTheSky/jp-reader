import { checkConnection, storageSet, SyncStorage } from './shared'

const $enabled = document.getElementById('enabled') as HTMLInputElement
const $ankiInput = document.getElementById('anki-url') as HTMLInputElement
const $ankiQueryInput = document.getElementById(
  'anki-query',
) as HTMLInputElement
const $ankiExpressionFieldInput = document.getElementById(
  'anki-expression-field',
) as HTMLInputElement
const $ankiKanjiQueryInput = document.getElementById(
  'anki-kanji-query',
) as HTMLInputElement
const $ankiKanjiFieldInput = document.getElementById(
  'anki-kanji-field',
) as HTMLInputElement
const $ankiEnabled = document.getElementById('anki-enabled') as HTMLInputElement
const $ankiKanjiEnabled = document.getElementById(
  'anki-kanji-enabled',
) as HTMLInputElement
const $ankiConnectStatus = document.getElementById('anki-connect-status')!
const $furiganaField = document.getElementById('furigana') as HTMLSelectElement

for (const $input of [
  $ankiEnabled,
  $ankiExpressionFieldInput,
  $ankiInput,
  $ankiKanjiEnabled,
  $ankiKanjiFieldInput,
  $ankiKanjiQueryInput,
  $ankiQueryInput,
  $enabled,
  $furiganaField,
])
  $input.addEventListener('change', update)

async function update() {
  updateUI()
  await storageSet({
    ankiUrl: $ankiInput.value.trim(),
    ankiQuery: $ankiQueryInput.value.trim(),
    ankiExpressionField: $ankiExpressionFieldInput.value.trim(),
    ankiKanjiQuery: $ankiKanjiQueryInput.value.trim(),
    ankiKanjiField: $ankiKanjiFieldInput.value.trim(),
    ankiEnabled: $ankiEnabled.checked,
    ankiKanjiEnabled: $ankiKanjiEnabled.checked,
    furigana: +$furiganaField.value,
    enabled: $enabled.checked,
  })
  await checkAnkiConnection()
}

function updateUI() {
  if ($enabled.checked) {
    for (const x of [
      ...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        'input, select',
      ),
    ].slice(1))
      x.disabled = false
    $ankiQueryInput.disabled = !$ankiEnabled.checked
    $ankiExpressionFieldInput.disabled = !$ankiEnabled.checked
    $ankiKanjiQueryInput.disabled = !$ankiKanjiEnabled.checked
    $ankiKanjiFieldInput.disabled = !$ankiKanjiEnabled.checked
  } else
    for (const x of [
      ...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        'input, select',
      ),
    ].slice(1))
      x.disabled = true
}

async function checkAnkiConnection() {
  try {
    $ankiConnectStatus.style.removeProperty('background-color')
    $ankiConnectStatus.style.backgroundColor = (await checkConnection())
      ? 'lawngreen'
      : 'red'
  } catch {
    $ankiConnectStatus.style.backgroundColor = 'red'
  }
}

const data = await chrome.storage.sync.get<SyncStorage>()

$ankiEnabled.checked = data.ankiEnabled
$ankiExpressionFieldInput.value = data.ankiExpressionField
$ankiInput.value = data.ankiUrl
$ankiKanjiEnabled.checked = data.ankiKanjiEnabled
$ankiKanjiFieldInput.value = data.ankiKanjiField
$ankiKanjiQueryInput.value = data.ankiKanjiQuery
$ankiQueryInput.value = data.ankiQuery
$enabled.checked = data.enabled
$furiganaField.value = data.furigana.toString()
void checkAnkiConnection()
updateUI()
