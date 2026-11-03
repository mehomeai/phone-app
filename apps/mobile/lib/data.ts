import type { Conversation, FeedItem, ModelId, Profile, Settings } from './types';

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 9);

export const TOPICS = ['Engineering', 'Nature', 'Earth', 'Space', 'Animals'];

export const MODELS: { id: ModelId; name: string; size: string; note: string }[] = [
  { id: 'me-small', name: 'Me Small', size: '3.8 GB', note: 'Quick everyday replies' },
  { id: 'me-balanced', name: 'Me Balanced', size: '8.4 GB', note: 'Default for the household' },
  { id: 'me-deep', name: 'Me Deep', size: '21.7 GB', note: 'Slower, longer reasoning' },
];

export const FEED: FeedItem[] = [
  {
    id: 'bridge', topic: 'Engineering', title: 'How cargo spacecraft dock in orbit',
    question: 'Why must both spacecraft move at nearly the same speed to dock?',
    body: 'A cargo vehicle lines up with the station, then uses careful corrections for a controlled approach.',
    transcript: 'A cargo craft lines up with the space station and matches its motion. The station’s robotic arm reaches out, captures it, and guides it to a berthing port.',
    video: 'https://archive.org/download/NASA-Animations/Animation_HTV_Approach-Grapple-Berth_350059.mp4',
    sourceName: 'NASA animation',
    sourceUrl: 'https://archive.org/details/NASA-Animations',
  },
  {
    id: 'bees', topic: 'Nature', title: 'A flower, sped up',
    question: 'What changed between frames—and what might the camera leave out?',
    body: 'A time-lapse makes slow growth visible. It is useful evidence, but only one view of a living system.',
    transcript: 'A flower opens in a time-lapse. The sped-up sequence makes gradual growth visible, while showing only one view of the plant.',
    video: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    sourceName: 'MDN sample video · CC0',
    sourceUrl: 'https://interactive-examples.mdn.mozilla.net/pages/tabbed/video.html',
  },
  {
    id: 'volcano', topic: 'Earth', title: 'A volcanic plume from space',
    question: 'What evidence would help tell ash apart from cloud?',
    body: 'Satellite views can show a plume’s path. Wind data and measurements on the ground add context.',
    transcript: 'Satellite observations follow Iceland’s ash plume hour by hour from May 6–8, 2010. The visualization shows its path and estimated height.',
    video: 'https://svs.gsfc.nasa.gov/vis/a000000/a003700/a003783/VolcanicAsh_small.mp4',
    sourceName: 'NASA Scientific Visualization Studio',
    sourceUrl: 'https://svs.gsfc.nasa.gov/3783',
  },
  {
    id: 'stars', topic: 'Space', title: 'How the first stars switched on',
    question: 'What clues could help us study something that happened so long ago?',
    body: 'This NASA animation traces the early universe as stars and galaxies began to form.',
    transcript: 'A pinpoint of light expands into an evolving universe. The animation then shows the first stars and galaxies forming.',
    video: 'https://svs.gsfc.nasa.gov/vis/a010000/a010100/a010128/BigBang_HD_LARGE_QT_Video_1.mp4',
    sourceName: 'NASA Scientific Visualization Studio',
    sourceUrl: 'https://svs.gsfc.nasa.gov/10128',
  },
  {
    id: 'cat', topic: 'Animals', title: 'How honeybees help map a changing climate',
    question: 'Why might a pollinator’s health reveal changes in its environment?',
    body: 'Bee activity and hive conditions can give researchers clues about flowers, seasons and local ecosystems.',
    transcript: 'Two timings are compared: flowers bloom as bees emerge to forage, then flowers bloom earlier. In the second case, bees miss nectar and flowers miss pollination.',
    video: 'https://svs.gsfc.nasa.gov/vis/a010000/a010400/a010482/HoneybeeShortAnim_ipod.m4v',
    sourceName: 'NASA Scientific Visualization Studio',
    sourceUrl: 'https://svs.gsfc.nasa.gov/10482',
  },
];

export const SEED_PROFILES: Profile[] = [
  { id: 'p-maya', name: 'Maya Okafor', role: 'parent' },
  { id: 'p-theo', name: 'Theo Okafor', role: 'child' },
  { id: 'p-ines', name: 'Ines Okafor', role: 'adult' },
];

export const SEED_SETTINGS: Settings = {
  assistantMode: 'demo',
  homeUrl: '',
  model: 'me-balanced',
  learningMix: 62,
  topics: ['Engineering', 'Space'],
  approvalRequired: true,
};

const t0 = Date.now() - 1000 * 60 * 60 * 26;
export const SEED_CONVERSATIONS: Conversation[] = [
  {
    id: 'c-seed-1', profileId: 'p-maya', title: 'Talking to Theo about the test result',
    assistantMode: 'demo',
    messages: [
      { id: 'm1', role: 'user', text: 'Theo failed his science test and he is ashamed. How do I bring it up tonight without making it worse?', createdAt: t0 },
      { id: 'm2', role: 'assistant', text: '[Scripted demo reply] Start with curiosity, not the grade. Ask which question felt hardest and what he tried. Let him explain his thinking before you offer yours.', createdAt: t0 + 9000 },
    ],
  },
  {
    id: 'c-seed-2', profileId: 'p-theo', title: 'Why do bridges sway?',
    assistantMode: 'demo',
    messages: [
      { id: 'm3', role: 'user', text: 'Why do bridges move in the wind?', createdAt: t0 + 3600000 },
      { id: 'm4', role: 'assistant', text: '[Scripted demo reply] Good question. Before I answer: what do you think would happen to something that could not bend at all?', createdAt: t0 + 3609000 },
    ],
  },
];

const ADULT_REPLIES = [
  'Here is how I would think about it. Name the one thing that matters most to you here, then we can work backwards from that.',
  'That sounds heavy. You do not need to solve all of it tonight. What is the smallest next step you would feel okay taking?',
  'I can draft something with you. If it ever needs an outside service, your approval rule would apply first.',
  'Let me reflect it back: you want honesty without blame. Does that sound right?',
];
const CHILD_REPLIES = [
  'Before I answer, what is your best guess? Guessing first makes the answer stick.',
  'Interesting. How could we check if that is true instead of just trusting me?',
  'Here is one clue, not the whole answer. What does it make you think of?',
];

export function scriptedReply(role: Profile['role'], index: number) {
  const pool = role === 'child' ? CHILD_REPLIES : ADULT_REPLIES;
  return `[Scripted demo reply] ${pool[index % pool.length]}`;
}

export function rankFeed(topics: string[], mix: number): FeedItem[] {
  // Higher mix pulls chosen topics to the top; lower mix keeps the order wide.
  const w = mix / 100;
  return FEED.map((item, i) => ({ item, score: (topics.includes(item.topic) ? 1 : 0) * w * 10 - i * (1 - w) * 0.5 - i * 0.01 }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
}

export const roleLabel = (r: Profile['role']) => (r === 'parent' ? 'Parent' : r === 'child' ? 'Child' : 'Adult');
export const initials = (n: string) => n.split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
