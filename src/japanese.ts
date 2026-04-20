const JAPANESE_CONVERSION_TABLE = `！	！	!
？	？	?
。	。	.
：	：	:
・	・	/
、	、	,
〜	〜	~
ー	ー	-
「	「	‘
」	」	’
『	『	“
』	』	”
［	［	[
］	］	]
（	（	(
）	）	)
｛	｛	{
｝	｝	}
か	カ	ka
き	キ	ki
く	ク	ku
け	ケ	ke
こ	コ	ko
さ	サ	sa
し	シ	shi
す	ス	su
せ	セ	se
そ	ソ	so
た	タ	ta
ち	チ	chi
つ	ツ	tsu
て	テ	te
と	ト	to
な	ナ	na
に	ニ	ni
ぬ	ヌ	nu
ね	ネ	ne
の	ノ	no
は	ハ	ha
ひ	ヒ	hi
ふ	フ	fu
へ	ヘ	he
ほ	ホ	ho
ま	マ	ma
み	ミ	mi
む	ム	mu
め	メ	me
も	モ	mo
ら	ラ	ra
り	リ	ri
る	ル	ru
れ	レ	re
ろ	ロ	ro
や	ヤ	ya
ゆ	ユ	yu
よ	ヨ	yo
わ	ワ	wa
ゐ	ヰ	wi
ゑ	ヱ	we
を	ヲ	wo
が	ガ	ga
ぎ	ギ	gi
ぐ	グ	gu
げ	ゲ	ge
ご	ゴ	go
ざ	ザ	za
じ	ジ	ji
ず	ズ	zu
ぜ	ゼ	ze
ぞ	ゾ	zo
じゃ	ジャ	ja
じゅ	ジュ	ju
じょ	ジョ	jo
だ	ダ	da
ぢ	ヂ	ji
づ	ヅ	zu
で	デ	de
ど	ド	do
ぢゃ	ヂャ	ja
ぢゅ	ヂュ	ju
ぢょ	ヂョ	jo
ば	バ	ba
び	ビ	bi
ぶ	ブ	bu
べ	ベ	be
ぼ	ボ	bo
ぱ	パ	pa
ぴ	ピ	pi
ぷ	プ	pu
ぺ	ペ	pe
ぽ	ポ	po
あ	ア	a
い	イ	i
う	ウ	u
え	エ	e
お	オ	o
や	ヤ	ya
ゆ	ユ	yu
よ	ヨ	yo
ぁ	ァ	a
ぃ	ィ	i
ぅ	ゥ	u
ぇ	ェ	e
ぉ	ォ	o
ゃ	ャ	ya
ゅ	ュ	yu
ょ	ョ	yo
ん	ン	n`
  .split('\n')
  .map((line) => line.split('\t')) as [string, string, string][]
const EAT_PREV = 'ぁぃぅぇぉゃゅょァィゥェォャュョ'
const DOUBLEH = 'っ'
const DOUBLEK = 'ッ'
const KATALONG = 'ー'
const UH = 'う'
const UK = 'ゥ'
const KANA_TO_ROMAJI = new Map<string, string>()
for (let index = 0; index < JAPANESE_CONVERSION_TABLE.length; index++) {
  const [hira, kata, roma] = JAPANESE_CONVERSION_TABLE[index]!
  KANA_TO_ROMAJI.set(hira, roma)
  KANA_TO_ROMAJI.set(kata, roma)
}
const HIRAGANA_LONG = new Map([
  ['a', 'あ'],
  ['i', 'い'],
  ['u', 'う'],
  ['e', 'え'],
  ['o', 'う'],
])

export function kanaToRomaji(text: string) {
  let romaji = ''
  let prev
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    // Double previous
    if (char === KATALONG && prev && prev !== 'n')
      romaji += romaji[romaji.length - 1]
    // Remove previous
    else if (EAT_PREV.includes(char) && prev && prev !== 'n') {
      romaji = romaji.slice(0, romaji.length - 1) + KANA_TO_ROMAJI.get(char)!
      // If shi chi, remove y. For example instead of shya, sha
      if (
        romaji[romaji.length - 3] === 'h' &&
        romaji[romaji.length - 2] === 'y'
      )
        romaji = romaji.slice(0, romaji.length - 2) + romaji[romaji.length - 1]
      // Double next
    } else if (prev === DOUBLEH || prev === DOUBLEK) {
      const add = KANA_TO_ROMAJI.get(char) ?? char
      romaji = romaji.slice(0, romaji.length - 1) + add[0] + add
      // OU to OO
    } else if ((char === UH || char === UK) && prev === 'o') romaji += 'o'
    else romaji += KANA_TO_ROMAJI.get(char) ?? char
    prev = char
  }
  return romaji
}

export function katakanaToHiragana(text: string) {
  let hiragana = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const code = text.charCodeAt(i)
    if (char === 'ー' && hiragana.length > 0) {
      const romaji = KANA_TO_ROMAJI.get(hiragana[hiragana.length - 1]!)
      hiragana +=
        (romaji && HIRAGANA_LONG.get(romaji[romaji.length - 1]!)) ?? 'ー'
    } else if (code >= 12449 && code <= 12540)
      hiragana += String.fromCharCode(code - 96)
    else hiragana += char
  }
  return hiragana
}
