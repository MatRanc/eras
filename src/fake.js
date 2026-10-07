// Fake Last.fm user for checking every alphabet's font and label width: localhost:8000/?user=_fonts
// Each artist below runs a 4-month era, two months after the last, so neighbours share the timeline.
// Last.fm usernames start with a letter, so _fonts can't clash with a real account. index.html loads this everywhere but the live site.
// Only the user's own calls are faked: tags and covers come from the real API (made-up albums cache as coverless).
{ // block scope: keeps these names out of app.js's globals
  const ARTISTS = [ // [artist, album]; genre mode uses their real Last.fm tags
    ['Metallica', 'Master of Puppets'],
    ['Ария', 'Герой асфальта'],
    ['Βασίλης Παπακωνσταντίνου', 'Χαίρετε'],
    ['فيروز', 'وطني (Live)'],
    ['אריק אינשטיין', 'שבלול'],
    ['เบิร์ด ธงไชย', 'ชุดรักเธอเสมอ'],
    ['लता मंगेशकर', 'सदाबहार गीत'],
    ['অর্থহীন', 'ত্রিমাত্রিক'],
    ['இளையராஜா', 'புன்னகை மன்னன்'],
    ['ఘంటసాల', 'మాయాబజార్'],
    ['ರಾಜ್‌ಕುಮಾರ್', 'ಬಂಗಾರದ ಮನುಷ್ಯ'],
    ['കെ. ജെ. യേശുദാസ്', 'ചെമ്മീൻ'],
    ['હેમંત ચૌહાણ', 'ભજન સંધ્યા'],
    ['ਗੁਰਦਾਸ ਮਾਨ', 'ਪੰਜਾਬੀ ਗੀਤ'],
    ['මහසෝනා', 'සිංහල ගීත'],
    ['ଅକ୍ଷୟ ମହାନ୍ତି', 'ଓଡ଼ିଆ ଗୀତ'],
    ['ნატო გელაშვილი', 'ქართული ხმები'],
    ['Կոմիտաս', 'Անտունի'],
    ['ሙላቱ አስታጥቄ', 'ኢትዮጲክስ'],
    ['ស៊ីន ស៊ីសាមុត', 'ចម្រៀងមាស'],
    ['ບຸນຄ້ຳ ສິດທິເດດ', 'ລຳລາວ'],
    ['စောထက်နိုင်စိုး', 'သီချင်းများ'],
    ['宇多田ヒカル', 'First Love'],
    ['아이유', '꽃갈피'],
    ['薛之谦', '意外'],
    ['ޒުވާނުން', 'ދިވެހި ލަވަ'],
    ['人間椅子 Ningen Isu', '無情のスキャット — 怪談 そして死とエロス (Live at 日比谷野外大音楽堂, 2013)'], // long, mixed, truncated label
  ];
  const now = new Date(), last = now.getUTCFullYear() * 12 + now.getUTCMonth() - 2;
  const first = last - 2 * ARTISTS.length - 2;

  // cached charts would hide edits to this file
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('eras1:_fonts:')) localStorage.removeItem(k); } catch { /* storage blocked: nothing cached */ }

  const month = from => { const d = new Date(from * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth() - first; };
  // 400 plays a month during an artist's era, 2 otherwise (the least a chart keeps): background too thin to make eras
  const playing = i => ARTISTS.map(([artist, album], k) => [artist, album, i >= 2 * k && i < 2 * k + 4 ? 400 : 2]);
  let total = 0;
  for (let i = 0; i <= now.getUTCFullYear() * 12 + now.getUTCMonth() - first; i++) for (const x of playing(i)) total += x[2];

  window.fakeLastfm = (method, p) => {
    if (p.user === '_fonts') {
      if (method === 'user.getinfo') return { user: { name: '_fonts', playcount: String(total), registered: { unixtime: String(Date.UTC(Math.floor(first / 12), first % 12, 1) / 1000) } } };
      const i = month(p.from);
      if (method === 'user.getweeklyartistchart') return { weeklyartistchart: { artist: playing(i).map(([name, , n]) => ({ name, playcount: String(n) })) } };
      if (method === 'user.getweeklyalbumchart') return { weeklyalbumchart: { album: playing(i).map(([artist, name, n]) => ({ name, artist: { '#text': artist }, playcount: String(n) })) } };
    }
    return null;
  };
}
