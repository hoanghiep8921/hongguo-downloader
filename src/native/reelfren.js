/**
 * reelfren.js - nguồn dữ liệu thứ hai: phim ngắn của mọi nhà cung cấp trên reelfren (PineDrama, ShortMax, NetShort, ...)
 *
 * API (đối chiếu plugin ReelFren của TJ-Plugins, đo thực tế 2026-11-03):
 *   Danh sách: /api/home?provider=P&category=0|1&offset=0&lang=vi -> { data: [{ id, title, cover, intro, episodes }] }
 *   Tìm kiếm : /api/search?provider=P&q=Q&lang=vi&offset=0        -> { data, hasMore } (mỗi trang ~20 phim)
 *   Phát     : /api/video?provider=P&id=ID&ep=N&lang=vi&server=1&cv=v21
 *          -> { title, totalEpisodes, locked, videoUrl, qualityList, kid? }
 *   videoUrl có thể là MP4 trực tiếp, luồng HLS (.m3u8, có khi không mang đuôi) hoặc đường dẫn tương đối /api/proxy/<P>?url=...
 * Trang web reelfren.net bị thử thách Cloudflare chặn, nhưng API trên các host dưới đây vẫn lấy thẳng được JSON.
 * Các nguồn mới hơn (AnyReel, Shortical, ToonShort...) chỉ có trên api.reelfren.net; máy chủ hay trả 502 tạm thời nên có thử lại.
 *
 * ID nội bộ (phân biệt với ID toàn số của Hongguo, và dùng thẳng được làm tên file):
 *   series_id = rf-<provider>-<id>      vid = rf-<provider>-<id>-<số tập>
 *   <id> được mã hóa chỉ còn [A-Za-z0-9_] (ID dạng UUID/slug có dấu '-'); ID toàn chữ số giữ nguyên như bản cũ.
 */
const axios = require('axios');

const HOSTS = ['https://www.reelfren.com', 'https://api.reelfren.net'];
const LANG = 'vi';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PREFIX = 'rf-';
const DEFAULT_PROVIDER = 'pinedrama';

// Danh sách nguồn trên reelfren.net/explore (id = tham số provider). Có nguồn lúc chết lúc sống nên không lọc sẵn ở đây
const PROVIDERS = [
  ['pinedrama', 'PineDrama'], ['shortmax', 'ShortMax'], ['netshort', 'NetShort'], ['happyshort', 'HappyShort'],
  ['dramawave', 'DramaWave'], ['freereels', 'FreeReels'], ['reelife', 'Reelife'], ['sereal', 'Sereal+'],
  ['melolo', 'Melolo'], ['movieboxshorts', 'MovieBox Shorts'], ['flextv', 'FlexTV'], ['flextv2', 'FlexTV 2'],
  ['cubetv', 'CubeTV'], ['candyjar', 'CandyJar'], ['flareflow', 'FlareFlow'], ['mydrama', 'MyDrama'],
  ['kalostv', 'KalosTV'], ['storyreel', 'StoryReel'], ['vibeshort', 'VibeShort'], ['anyreel', 'AnyReel'],
  ['winknovel', 'WinkNovel'], ['iqiyi', 'iQIYI'], ['filmbox', 'FilmBox'], ['aniboy', 'AniBoy'],
  ['vigloo', 'Vigloo'], ['vigloo2', 'Vigloo 2'], ['shorten', 'Shorten'], ['reelshort', 'ReelShort'],
  ['reelshort2', 'ReelShort 2'], ['dramabox', 'DramaBox'], ['dramanova', 'DramaNova'], ['anamana', 'Anamana'],
  ['rapidtv', 'RapidTV'], ['rapidtv2', 'RapidTV 2'], ['raptdrama', 'RaptDrama'], ['joyreels', 'JoyReels'],
  ['shortical', 'Shortical'], ['storeel', 'StoReel'], ['loveshots', 'LoveShots'], ['momeshort', 'MomeShort'],
  ['moreshort', 'MoreShort'], ['toonshort', 'ToonShort'], ['sixthshort', 'SixthShort'], ['soreel', 'SoReel'],
  ['storygo', 'StoryGo'], ['minishort', 'MiniShort'], ['mymuse', 'My Muse'], ['wetv', 'WeTV'],
  ['moviebox', 'MovieBox'], ['bonustv', 'BonusTV'], ['moboreels', 'MoboReels'], ['playlet', 'PlayLet'],
  ['blinkdrama', 'BlinkDrama'],
].map(([id, name]) => ({ id, name }));
const providerName = (p) => (PROVIDERS.find((x) => x.id === p) || { name: p }).name;

// Ảnh bìa / tên phim đã thấy trong danh sách, dự phòng khi /api/detail lỗi (/api/video không có ảnh bìa, title là tên tập)
const coverCache = new Map();
const titleCache = new Map();

const owns = (id) => String(id || '').startsWith(PREFIX);

// Mã hóa thuận nghịch: mọi byte UTF-8 ngoài chữ/số thành _XX (hex), nên '_' của chính ID cũng được mã hóa
const encId = (id) => encodeURIComponent(String(id))
  .replace(/[^A-Za-z0-9%]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
  .replace(/%/g, '_');
const decId = (s) => decodeURIComponent(s.replace(/_/g, '%'));

function parseId(id) {
  const m = String(id).match(/^rf-([a-z0-9]+)-([A-Za-z0-9_]+?)(?:-(\d+))?$/);
  if (!m) throw new Error('ID reelfren không hợp lệ: ' + id);
  return { provider: m[1], id: decId(m[2]), ep: m[3] ? Number(m[3]) : 0 };
}

/**
 * Thử lần lượt từng host; lỗi mạng / không phải 200 / không phải JSON (như trang Cloudflare) thì chuyển sang host kế tiếp.
 * quick: chỉ một lượt, thời gian chờ ngắn (dùng khi tìm trên hàng chục nguồn cùng lúc)
 */
async function getJson(pathAndQuery, { quick = false } = {}) {
  let lastErr;
  for (let round = 0; round < (quick ? 1 : 2); round++) {
    if (round) await new Promise((r) => setTimeout(r, 1500));
    for (const host of HOSTS) {
      try {
        const { data } = await axios.get(host + pathAndQuery, {
          headers: { 'User-Agent': UA, Accept: 'application/json', Referer: host + '/' },
          timeout: quick ? 10000 : 20000,
        });
        if (data && typeof data === 'object') return data;
        lastErr = new Error('phản hồi không phải JSON');
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw new Error('reelfren không phản hồi: ' + (lastErr && lastErr.message));
}

function toCard(d, provider) {
  const p = d.provider || provider;
  const series_id = `${PREFIX}${p}-${encId(d.id)}`;
  if (d.cover) coverCache.set(series_id, d.cover);
  if (d.title) titleCache.set(series_id, d.title);
  return {
    series_id,
    series_title: d.title || '',
    cover: d.cover || '',
    episode_count: Number(d.episodes) || 0,
    tags: String(d.intro || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4),
    note: providerName(p),
  };
}

const uniqueCards = (items, provider) =>
  [...new Map(items.map((d) => [String(d.id), d])).values()].map((d) => toCard(d, provider));

/** Trang chủ của một nguồn chỉ có hai mục (category 0/1), offset không có tác dụng nên chỉ có một trang */
async function listHome(provider = DEFAULT_PROVIDER) {
  const pages = await Promise.all(['0', '1'].map((c) =>
    getJson(`/api/home?provider=${provider}&category=${c}&offset=0&lang=${LANG}`).catch(() => null)));
  if (pages.every((p) => !p)) throw new Error(`${providerName(provider)}: reelfren không phản hồi`);
  return uniqueCards(pages.flatMap((p) => (p && p.data) || []), provider);
}

async function search(keyword, provider = DEFAULT_PROVIDER, opts) {
  const j = await getJson(`/api/search?provider=${provider}&q=${encodeURIComponent(keyword)}&lang=${LANG}&offset=0`, opts);
  return uniqueCards(j.data || [], provider);
}

/**
 * Tìm trên mọi nguồn, 8 nguồn song song, mỗi nguồn lấy tối đa perProvider phim; nguồn lỗi thì bỏ qua.
 * ponytail: ~55 yêu cầu mỗi lần tìm (đo thực tế ~22 giây); nếu chậm quá thì cho người dùng chọn nguồn để tìm
 */
async function searchAll(keyword, perProvider = 10) {
  const out = new Array(PROVIDERS.length);
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < PROVIDERS.length) {
      const i = next++;
      out[i] = await search(keyword, PROVIDERS[i].id, { quick: true }).then((l) => l.slice(0, perProvider), () => []);
    }
  }));
  return out.flat();
}

async function videoInfo(provider, id, ep) {
  const j = await getJson(`/api/video?provider=${provider}&id=${encodeURIComponent(id)}&ep=${ep}&lang=${LANG}&server=1&cv=v21`);
  if (j.error) throw new Error(String(j.error));
  return j;
}

/**
 * Danh sách tập: ưu tiên /api/detail (chỉ có trên api.reelfren.net) -> { title, cover, episodes, videos: [{ episode, available }] }.
 * Không dùng tên/số tập của /api/video: với đa số nguồn title là tên tập («Episode 1», «第一集») và totalEpisodes luôn là 1
 * dù phim có hàng chục tập — mọi phim sẽ dồn vào cùng thư mục «Episode 1» và chỉ tải được một tập.
 * /api/video chỉ là phương án dự phòng khi /api/detail lỗi (tập 1 đôi khi bị 502 tạm thời thì lấy bằng tập 2).
 */
async function fetchEpisodeList(seriesId) {
  const sid = String(seriesId);
  const { provider, id } = parseId(sid);
  const detail = await getJson(`/api/detail?provider=${provider}&id=${encodeURIComponent(id)}&lang=${LANG}`).catch(() => null);
  const videos = (detail && Array.isArray(detail.videos) && detail.videos) || [];
  let total = videos.length || Number(detail && detail.episodes) || 0;
  let title = (detail && detail.title) || titleCache.get(sid);
  if (!total || !title) {
    const info = await videoInfo(provider, id, 1).catch(() => videoInfo(provider, id, 2));
    total = total || Number(info.totalEpisodes) || 1;
    // Tên tập kiểu «Episode 1» / «NetShort Episode 1» / «第一集» không dùng làm tên phim được
    title = title || String(info.title || '').replace(/(^|\s)(episode|ep)\s*\d+$|^第.+集$/i, '').trim();
  }
  title = title || `${providerName(provider)} ${id}`;
  const cover = (detail && detail.cover) || coverCache.get(sid) || '';
  const indexes = videos.length
    ? videos.map((v, i) => Number(v.episode) || i + 1)
    : Array.from({ length: total }, (_, i) => i + 1);
  const episodes = indexes.map((n) => ({
    vid: `${sid}-${n}`,
    vid_index: n,
    title: '',
    series_id: sid,
    series_title: title,
    cover,
  }));
  return { series_id: sid, series_title: title, cover, total: episodes.length, episodes, source: 'reelfren' };
}

/** Đọc vài byte đầu để nhận ra luồng HLS (có nguồn trả link .m3u8 không mang đuôi) */
async function isHls(url) {
  if (/\.m3u8(\?|$)/i.test(url)) return true;
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-15' },
      responseType: 'arraybuffer',
      timeout: 15000,
    });
    return Buffer.from(res.data || []).toString('latin1').startsWith('#EXTM3U');
  } catch (_) {
    return false; // Không đọc được thì cứ thử tải như MP4, lỗi sẽ hiện ở bước tải
  }
}

/**
 * Cùng dạng với hongguo.fetchPlayUrlSingle: spadeA rỗng nghĩa là không cần giải mã.
 * hls=true: bên gọi tải bằng yt-dlp thay vì tải thẳng một tệp.
 */
async function fetchPlayUrlSingle(vid) {
  try {
    const { provider, id, ep } = parseId(vid);
    const info = await videoInfo(provider, id, ep || 1);
    // File mã hóa kiểu Melolo chỉ giải mã để phát được trên web, tải về sẽ là file hỏng
    if (info.kid) return { url: null, spadeA: null, codec: null, error: 'tập này bị mã hóa, chỉ phát được trên web' };
    if (info.locked) return { url: null, spadeA: null, codec: null, error: 'tập này bị khóa' };
    let url = info.videoUrl || ((info.qualityList || []).find((q) => q && q.url) || {}).url;
    if (!url) return { url: null, spadeA: null, codec: null, error: 'reelfren không trả về liên kết video' };
    if (url.startsWith('/')) url = HOSTS[0] + url; // Link qua proxy của reelfren (AniBoy, Vigloo)
    return { url, spadeA: null, codec: '', source: 'reelfren', hls: await isHls(url) };
  } catch (e) {
    return { url: null, spadeA: null, codec: null, error: e.message };
  }
}

/** Dán link reelfren: /drama/<provider>/<id>-slug hoặc /watch/<provider>/<id>-slug */
function seriesIdFromUrl(input) {
  const m = String(input || '').match(/reelfren\.[a-z]+\/(?:drama|watch)\/([a-z0-9]+)\/([^?#/-]+)/i);
  return m ? `${PREFIX}${m[1].toLowerCase()}-${encId(m[2])}` : null;
}

module.exports = {
  owns, PROVIDERS, DEFAULT_PROVIDER, listHome, search, searchAll, fetchEpisodeList, fetchPlayUrlSingle, seriesIdFromUrl,
  encId, parseId,
};
