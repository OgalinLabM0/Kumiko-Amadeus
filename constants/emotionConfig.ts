import type { EmotionType } from '../types';

export const KUMIKO_EMOTION_IMAGES: Record<string, string> = {
  'neutral': './images/emotions/Neutral-2.png',
  'smiling': './images/emotions/Neutral.png',
  'happy': './images/emotions/Happy.png',
  'angry': './images/emotions/Angry&Annoyed.png',
  'sad': './images/emotions/Sad-2.png',
  'shy': './images/emotions/Embarrassed.png',
  'surprised': './images/emotions/Surprised-2.png',
  'resigned': './images/emotions/Resigned.png',
  'serious': './images/emotions/Serious.png',
  'gentle': './images/emotions/Gentle.png',
  'sleepy': './images/emotions/Sleepy.png',
  'confused': './images/emotions/Confused.png',
  'confused_2': './images/emotions/Confused-2.png',
  'disgusted': './images/emotions/Disgusted.png',
  'smug': './images/emotions/Smug&Teasing.png',
  'worried': './images/emotions/Worried.png',
  'worried_2': './images/emotions/Worried-2.png'
};

export const EMOTION_TO_FISH_AUDIO_TAGS: Record<EmotionType, string[]> = {
    neutral: ['[speaks naturally]', '[flat tone]'],
    smiling: ['[happy]', '[speaks lightly]'],
    happy: ['[excited]', '[laughing]', '[happy]'],
    angry: ['[angry]', '[shouting]', '[frustrated]'],
    sad: ['[sad]', '[sighs]', '[crying]'],
    shy: ['[shy]', '[nervous]', '[muttering]'],
    surprised: ['[surprised]', '[gasp]'],
    resigned: ['[sighs]', '[reluctant]', '[speaks tiredly]'],
    serious: ['[serious]', '[low voice]'],
    gentle: ['[speaks gently]', '[warm]'],
    sleepy: ['[sleepy]', '[yawning]'],
    confused: ['[confused]', '[pause]'],
    confused_2: ['[very confused]'],
    disgusted: ['[disgusted]', '[groans]', '[annoyed]'],
    smug: ['[smug]', '[confident]'],
    worried: ['[worried]', '[anxious]'],
    worried_2: ['[very worried]', '[panicked]'],
};

export const EMOTION_TTS_TEMPERATURE: Record<EmotionType, number> = {
    neutral: 0.7,
    smiling: 0.7,
    happy: 0.8,
    angry: 0.8,
    sad: 0.6,
    shy: 0.65,
    surprised: 0.8,
    resigned: 0.5,
    serious: 0.55,
    gentle: 0.6,
    sleepy: 0.5,
    confused: 0.65,
    confused_2: 0.7,
    disgusted: 0.7,
    smug: 0.7,
    worried: 0.65,
    worried_2: 0.7,
};

export interface SovitsRefVariant {
    file: string;
    promptText: string;
}

export const EMOTION_TO_SOVITS_REF: Record<EmotionType, SovitsRefVariant[]> = {
    neutral: [
        { file: 'neutral_casual', promptText: '万が一ってこともあるし…ごめん奏ちゃん、あとお願いできる?' },
        { file: 'neutral_formal', promptText: '2年生の秋、先輩の引退とともに、私は北宇治高校吹奏楽部部長に任命された。' },
    ],
    smiling: [
        { file: 'happy_teasing', promptText: 'まあ、そうだね~奏ちゃんはかわいい後輩だし~' },
    ],
    happy: [
        { file: 'happy_playful', promptText: '部長だって頑張ってるんだから~！' },
    ],
    smug: [
        { file: 'happy_laughing', promptText: 'だって、そうだろうなあって思ってたし。大変だよね？先輩って。' },
    ],
    angry: [
        { file: 'angry_intense', promptText: 'じゃあ、麗奈はどうしたらいいと思うの？上から正論言って納得するなら、誰だって苦労しないよ！' },
    ],
    disgusted: [
        { file: 'angry_mild', promptText: '麗奈は子供の頃からプロ奏者しか目指してなかったんだもんね。' },
    ],
    sad: [
        { file: 'sad_subdued', promptText: '各章が、春夏秋冬になってるって聞いたけど……結構……壮大、だよね……' },
        { file: 'sad_holding_back', promptText: 'ソリが私から別の子になった……うまくなって絶対取り返すぞって思ってる。' },
        { file: 'sad_crying', promptText: 'それを誇らしいって、思う自分に胸を張りたい…それで……最後は麗奈と、吹きたかった。' },
        { file: 'sad_crying_intense', promptText: 'こんなに練習しているのに、うまくならないはずない！こんなに真剣に向き合ってるのに、響かないはずない！' },
    ],
    worried: [
        { file: 'worried_low', promptText: 'はぁ…どうなるんだろう、そうなったら、緑ちゃんは…' },
        { file: 'worried_assertive', promptText: 'みんな従ってるよ。ただ、理解できないって言ってる人に、気持ちに蓋して妄信しろって言うのは無理でしょ？' },
    ],
    worried_2: [
        { file: 'resigned_insecure', promptText: '正直、音大はないかなって思ってる。大人になっても演奏を続けていたいって人が、行くべきところだと思うから。' },
    ],
    shy: [
        { file: 'shy_embarrassed', promptText: '何というか……まあ…ありがとう……' },
    ],
    confused: [
        { file: 'neutral_elevated', promptText: 'むしろ、みんな歓迎してくれると思うよ。元清良女子なら即戦力間違いなしだって。' },
    ],
    confused_2: [
        { file: 'shy_denial', promptText: '別に恥ずかしがってないよ!' },
    ],
    resigned: [
        { file: 'resigned_dismissive', promptText: 'オーディションで一番うまかった人が吹く、それだけだよ。' },
        { file: 'resigned_helpless', promptText: 'みんなが知らなければいいんだけど……奏ちゃんみたいに、何かあるって気付いてる子もいるから……逆にやっかいというか……' },
    ],
    sleepy: [
        { file: 'sleepy_tired', promptText: 'ほんと疲れたよ~長い1日だった……' },
        { file: 'resigned_exhausted', promptText: 'コンクールの練習に、合宿の段取り……これを優子先輩や夏紀先輩はやってたのか……' },
    ],
    serious: [
        { file: 'serious_low', promptText: '想像してみたの、全国で北宇治が演奏するところ。その最初の一音は何がいいかって。' },
        { file: 'serious_normal', promptText: '年に一度だけの吹奏楽コンクール。そこに出場するメンバーを決めるオーディション。' },
    ],
    gentle: [
        { file: 'gentle', promptText: 'ここはね……2年前、麗奈がソロをかけてオーディションした場所なんだ……' },
    ],
    surprised: [
        { file: 'surprised_excited', promptText: 'えっ！じゃあ、サリーちゃんもここにいるってことだよね?' },
    ],
};
