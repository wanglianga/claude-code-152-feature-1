import { useEffect, useState } from 'react';
import { api } from '../api';
import { Money, Empty } from '../ui';
import {
  TICKET_TYPE, FAIL_REASON, BLOCK_OPTION, HOIST_FAIL_CAUSE, CATEGORY,
} from '../labels';

export function OpsView() {
  const [data, setData] = useState<any>(null);
  const [profiles, setProfiles] = useState<any[]>([]);
  const [blocks, setBlocks] = useState<any>(null);

  useEffect(() => {
    api('/analytics/by-category').then(setData);
    api('/analytics/seller-profiles').then(setProfiles);
    api('/analytics/delivery-blocks').then(setBlocks).catch(() => setBlocks(null));
  }, []);

  if (!data) return <div className="empty">加载中…</div>;
  const cats = data.categories;
  const totalSold = cats.reduce((s: number, c: any) => s + c.soldCount, 0);
  const totalListed = cats.reduce((s: number, c: any) => s + c.listedCount, 0);
  const avgCycle = (() => {
    const v = cats.filter((c: any) => c.avgCycleDays != null).map((c: any) => c.avgCycleDays);
    return v.length ? (v.reduce((a: number, b: number) => a + b, 0) / v.length).toFixed(1) : '-';
  })();
  const totalFailed = cats.reduce((s: number, c: any) => s + c.deliveryFailed, 0);
  const totalDeliveries = cats.reduce((s: number, c: any) => s + c.deliveryTotal, 0);
  const failRate = totalDeliveries ? ((totalFailed / totalDeliveries) * 100).toFixed(1) : '0';

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>运营分析</h2>
          <div className="sub">按品类沉淀成交周期、翻新投入、退货原因与配送失败率，判断入仓寄卖还是同城自提</div>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card stat"><div className="l">在售/曾上架</div><div className="v">{totalListed}</div></div>
        <div className="card stat"><div className="l">累计成交</div><div className="v">{totalSold}</div></div>
        <div className="card stat"><div className="l">品类平均成交周期</div><div className="v">{avgCycle}<span style={{ fontSize: 14 }}> 天</span></div></div>
        <div className="card stat"><div className="l">整体配送失败率</div><div className="v">{failRate}%</div><div className="d">{totalFailed}/{totalDeliveries} 单</div></div>
      </div>

      <div className="card" style={{ padding: 0, marginBottom: 18 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>品类</th><th>上架/成交</th><th>平均成交周期</th><th>平均翻新投入</th>
                <th>翻新占均价比</th><th>退货率</th><th>配送失败率</th><th>主要退货/失败原因</th><th>渠道建议</th>
              </tr>
            </thead>
            <tbody>
              {cats.map((c: any) => (
                <tr key={c.category}>
                  <td><b>{c.categoryLabel}</b></td>
                  <td>{c.listedCount} / {c.soldCount}</td>
                  <td>{c.avgCycleDays == null ? '-' : `${c.avgCycleDays} 天`}</td>
                  <td>
                    <Money v={c.avgRefurbishCost} />
                    <div className="hint">均价 <Money v={c.avgDealPrice} /></div>
                  </td>
                  <td>{c.refurbishCostRatioPct}%</td>
                  <td>
                    <span className={c.returnRatePct >= 20 ? 'money-out' : ''}>{c.returnRatePct}%</span>
                    <div className="hint">{c.returnCount} 单退货</div>
                  </td>
                  <td>
                    <span className={c.deliveryFailRatePct >= 25 ? 'money-out' : ''}>{c.deliveryFailRatePct}%</span>
                    <div className="hint">{c.deliveryFailed}/{c.deliveryTotal} 单</div>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {Object.entries(c.returnReasons).map(([k, v]) => (
                      <div key={k}>{TICKET_TYPE[k] || k} ×{String(v)}</div>
                    ))}
                    {Object.entries(c.deliveryFailReasons).map(([k, v]) => (
                      <div key={k} className="muted">{FAIL_REASON[k] || k} ×{String(v)}</div>
                    ))}
                    {Object.keys(c.returnReasons).length + Object.keys(c.deliveryFailReasons).length === 0 && '-'}
                  </td>
                  <td style={{ minWidth: 220 }}>
                    <div className={`banner ${c.channelAdvice.includes('自提') ? 'warn' : c.channelAdvice.includes('适合入仓') ? 'info' : ''}`} style={{ margin: 0 }}>
                      {c.channelAdvice}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {blocks && blocks.total > 0 && <DeliveryBlockBoard data={blocks} />}

      <div className="section-title">卖家风险画像（再次寄卖验真依据）</div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>卖家</th><th>风险分</th><th>验真等级</th><th>反悔</th>
                <th>描述不符</th><th>售后争议</th><th>成交</th><th>说明</th>
              </tr>
            </thead>
            <tbody>
              {profiles.length === 0 && <tr><td colSpan={8}><Empty text="暂无卖家画像" /></td></tr>}
              {profiles.map((p) => (
                <tr key={p.id}>
                  <td><b>{p.sellerName}</b><div className="hint">{p.username}</div></td>
                  <td>
                    <b style={{ color: Number(p.riskScore) >= 4 ? '#dc2626' : '#16a34a' }}>{p.riskScore}</b>
                  </td>
                  <td>
                    <span className={`badge ${p.verificationLevel === 'STRICT' ? 'red' : 'green'}`}>
                      {p.verificationLevel === 'STRICT' ? '严格验真' : '常规'}
                    </span>
                  </td>
                  <td>{p.backtrackCount}</td>
                  <td>{p.mismatchCount}</td>
                  <td>{p.disputeCount}</td>
                  <td>{p.completedCount}</td>
                  <td className="muted" style={{ maxWidth: 280 }}>{p.riskNote}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="hint" style={{ marginTop: 10 }}>
        风险分 = 反悔次数×3 + 描述不符×2 + 售后争议×1 − 成交数×0.5；≥4 分或描述不符 ≥2 次，新寄卖自动进入严格上门验真。
      </div>
    </div>
  );
}

function DeliveryBlockBoard({ data }: { data: any }) {
  return (
    <>
      <div className="section-title">大件进不了电梯 · 配送改约看板</div>
      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <div className="card stat">
          <div className="l">累计受阻改约</div>
          <div className="v">{data.total}</div>
          <div className="d">买家四方案见下</div>
        </div>
        <div className="card stat">
          <div className="l">吊装成功 / 失败</div>
          <div className="v">{data.hoistSuccess} / {data.hoistFailed}</div>
          <div className="d">成功率 {data.hoistSuccessRatePct}%（共安排 {data.hoistChosen}）</div>
        </div>
        <div className="card stat">
          <div className="l">退货回库 / 二次上架</div>
          <div className="v">{data.returnCount} / {data.returnRelistCount}</div>
          <div className="d">回库后二次上架率 {data.relistRatePct}%</div>
        </div>
        <div className="card stat">
          <div className="l">改约附加费 / 第三方追偿</div>
          <div className="v" style={{ fontSize: 22 }}>
            <Money v={data.deliveredSurchargeTotal} />
          </div>
          <div className="d">已送达单附加费；追偿 <Money v={data.thirdPartyClaimTotal} /></div>
        </div>
      </div>
      <div className="grid grid-2" style={{ marginBottom: 18 }}>
        <div className="card">
          <h3>买家方案分布</h3>
          <table style={{ width: '100%' }}>
            <tbody>
              {['DISASSEMBLY', 'HOIST', 'RETURN', 'CHANGE_ADDRESS'].map((k) => (
                <tr key={k}>
                  <td style={{ width: 130 }}>{BLOCK_OPTION[k]}</td>
                  <td>{data.byOption[k] || 0} 单</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 style={{ marginTop: 12 }}>高发品类</h3>
          <div>
            {Object.entries(data.byCategory).map(([k, v]) => (
              <span className="tag" key={k} style={{ marginRight: 6 }}>
                {(CATEGORY as Record<string, string>)[k] || k} ×{String(v)}
              </span>
            ))}
          </div>
        </div>
        <div className="card">
          <h3>吊装失败责任归因</h3>
          {Object.keys(data.hoistFailCauses).length === 0 ? (
            <Empty text="暂无吊装失败" />
          ) : (
            <table style={{ width: '100%' }}>
              <tbody>
                {Object.entries(data.hoistFailCauses).map(([k, v]) => (
                  <tr key={k}>
                    <td style={{ width: 210 }}>{HOIST_FAIL_CAUSE[k]?.label || k}</td>
                    <td>{String(v)} 次</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="hint" style={{ marginTop: 10 }}>
            买家环境限制→吊装费买家承担（退货从退款扣除）；配送方案误判→平台承担；
            第三方责任→平台垫付后向吊装公司追偿，计入结算「第三方追偿」。
          </div>
        </div>
      </div>
    </>
  );
}
