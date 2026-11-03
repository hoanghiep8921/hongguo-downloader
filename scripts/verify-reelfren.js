/**
 * Kiểm tra nguồn reelfren: phân tích ID / link -> với từng nhà cung cấp: danh sách -> danh sách tập -> link phát -> MP4 hoặc HLS thật
 * Cách dùng: node scripts/verify-reelfren.js [provider ...]   (mặc định: pinedrama shortmax netshort mydrama aniboy)
 * In ra một dòng cho mỗi nguồn; thoát mã 1 nếu có nguồn hỏng.
 */
const assert = require('assert');
const axios = require('axios');
const reelfren = require('../src/native/reelfren');
const hongguo = require('../src/native/hongguo');

const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['pinedrama', 'shortmax', 'netshort', 'mydrama', 'aniboy'];

async function checkProvider(p) {
  const list = await reelfren.listHome(p);
  assert.ok(list.length > 0, 'danh sách trống');
  // Thử vài phim đầu: có phim trong danh sách nhưng /api/video lỗi
  let lastErr;
  for (const card of list.slice(0, 3)) {
    try {
      const data = await reelfren.fetchEpisodeList(card.series_id);
      assert.ok(data.total > 0 && data.episodes[0].vid === `${data.series_id}-1`);
      // Tên phim dùng làm tên thư mục: không được là tên tập («Episode 1», «第一集») như /api/video trả về
      assert.ok(!/(episode|ep)\s*\d+$|^第.+集$/i.test(data.series_title), 'tên phim là tên tập: ' + data.series_title);
      const play = await reelfren.fetchPlayUrlSingle(data.episodes[0].vid);
      assert.ok(play.url, 'không có link: ' + play.error);
      const res = await axios.get(play.url, {
        headers: { 'User-Agent': hongguo.UA, Range: 'bytes=0-2047' },
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      const head = Buffer.from(res.data);
      const kind = head.subarray(4, 8).toString('latin1') === 'ftyp' ? 'mp4' : head.toString('latin1').startsWith('#EXTM3U') ? 'hls' : '?';
      assert.strictEqual(kind, play.hls ? 'hls' : 'mp4', 'nhận dạng định dạng sai');
      return `${list.length} phim, «${data.series_title}» ${data.total} tập, ${kind.toUpperCase()}`;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

(async () => {
  // Phần offline: phân tích ID / link
  assert.ok(reelfren.owns('rf-pinedrama-123') && !reelfren.owns('7645222653694856254'));
  assert.strictEqual(
    reelfren.seriesIdFromUrl('https://reelfren.net/drama/pinedrama/7643719580606632977-khac-tinh?lang=vi'),
    'rf-pinedrama-7643719580606632977'
  );
  assert.strictEqual(reelfren.seriesIdFromUrl('https://hongguodanju.com/detail?series_id=1'), null);
  // ID có '-' / '_' / ký tự lạ: mã hóa thuận nghịch, tách được số tập, tên file an toàn
  for (const raw of ['6d25b4d3-d35e-44b9-9530-3f318e68c83e', 'nobody-knows-her', 'a_b%c—d', '7665357973480641556']) {
    const sid = `rf-mydrama-${reelfren.encId(raw)}`;
    assert.match(sid, /^[A-Za-z0-9_-]+$/);
    assert.deepStrictEqual(reelfren.parseId(sid), { provider: 'mydrama', id: raw, ep: 0 });
    assert.deepStrictEqual(reelfren.parseId(`${sid}-12`), { provider: 'mydrama', id: raw, ep: 12 });
  }
  assert.strictEqual(reelfren.encId('7665357973480641556'), '7665357973480641556'); // ID số của bản cũ không đổi

  let failed = 0;
  for (const p of targets) {
    try {
      console.log(`OK   ${p}: ${await checkProvider(p)}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${p}: ${e.message}`);
    }
  }
  console.log(failed ? `${failed}/${targets.length} nguồn hỏng` : 'OK');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
