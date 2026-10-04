import { useEffect, useState } from 'react';
import { api, getUser } from '../api';
import {
  Badge, Field, Money, toast,
} from '../ui';
import {
  TICKET_TYPE, TICKET_STATUS, ROLE, ROLE_COLOR, RESOLUTION, CATEGORY,
  BLOCK_STATUS, BLOCK_OPTION, HOIST_STATUS, HOIST_FAIL_CAUSE,
} from '../labels';
import { BlockDetail } from './DeliveryBlock';

export function TicketDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const me = getUser()!;
  const [data, setData] = useState<any>(null);
  const [content, setContent] = useState('');
  const [showResolve, setShowResolve] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openBlockId, setOpenBlockId] = useState<string | null>(null);

  const load = () => api(`/tickets/${id}`).then(setData);
  useEffect(() => {
    load();
  }, [id]);

  if (openBlockId) {
    return <BlockDetail id={openBlockId} onBack={() => { setOpenBlockId(null); load(); }} />;
  }
  if (!data) return <div className="empty">加载中…</div>;
  const { ticket, messages, consignment, item, order, delivery, block } = data;
  const isCs = ['CS', 'OPS', 'ADMIN'].includes(me.role);

  const send = async () => {
    if (!content.trim()) return;
    setBusy(true);
    try {
      await api(`/tickets/${id}/messages`, { body: { content } });
      setContent('');
      await load();
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <button className="btn ghost sm" onClick={onBack}>← 返回</button>
          <h2 style={{ marginTop: 10 }}>
            【{TICKET_TYPE[ticket.type]}】{ticket.title}
            <span style={{ marginLeft: 10 }}><Badge map={TICKET_STATUS} value={ticket.status} /></span>
            {ticket.resolution !== 'PENDING' && (
              <span className="badge blue" style={{ marginLeft: 6 }}>{RESOLUTION[ticket.resolution]}</span>
            )}
          </h2>
          <div className="sub">
            关联家具：{consignment.code} · {CATEGORY[consignment.category]} · {consignment.brand}
            {order && ` · 订单 ${order.code}`}
          </div>
        </div>
        {isCs && ticket.status !== 'CLOSED' && ticket.resolution === 'PENDING' && (
          <button className="btn" onClick={() => setShowResolve(true)}>客服裁定</button>
        )}
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>问题描述</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{ticket.description}</p>
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>发起人</dt>
            <dd><span className={`badge ${ROLE_COLOR[ticket.creatorRole]}`}>{ROLE[ticket.creatorRole]}</span></dd>
            <dt>责任方</dt><dd>{ticket.liableParty}</dd>
            <dt>赔付金额</dt><dd><Money v={ticket.compensationAmount} /></dd>
            {item && <>
              <dt>商品状态</dt><dd>{item.title}</dd>
              <dt>所在/库位</dt><dd>{item.location === 'WAREHOUSE' ? `仓库 ${item.warehouseSlot || '-'}` : '卖家家中'} · 配送半径 {item.deliveryRadiusKm}km</dd>
            </>}
            {order && <>
              <dt>成交价</dt><dd><Money v={order.dealPrice} />（配送费 <Money v={order.deliveryFee} />）</dd>
              <dt>买家楼层</dt><dd>{order.buyerFloor} 层 · {order.buyerElevator === 'ELEVATOR' ? '有电梯' : '无电梯'}{order.needOldFurnitureRemoval ? ' · 需搬出旧家具' : ''}</dd>
            </>}
            {delivery && <>
              <dt>车辆/拆装</dt><dd>{delivery.vehicleType} · {delivery.needsDisassembly ? '需拆装' : '无需拆装'}</dd>
              <dt>配送状态</dt><dd>
                {delivery.status}
                {delivery.status === 'FAILED' && <span className="badge red" style={{ marginLeft: 6 }}>{delivery.failReason}</span>}
              </dd>
              {delivery.failNote && <><dt>现场记录</dt><dd>{delivery.failNote}</dd></>}
            </>}
          </dl>
        </div>

        <div className="card">
          <h3>多方协同记录</h3>
          <div className="chat">
            {messages.length === 0 && <div className="muted">还没有留言，卖家、买家、仓库、翻新师、配送、客服在此围绕同一件家具协商。</div>}
            {messages.map((m: any) => (
              <div key={m.id} className={`msg ${m.authorId === me.id ? 'me' : ''}`}>
                <div className="mh">
                  <span className={`badge ${ROLE_COLOR[m.authorRole] || 'gray'}`}>{ROLE[m.authorRole] || m.authorRole}</span>
                  <b>{m.authorName}</b>
                  <span>{new Date(m.createdAt).toLocaleString()}</span>
                </div>
                <div className="mc">{m.content}</div>
              </div>
            ))}
          </div>
          <Field label="补充信息 / 处理意见">
            <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="例如：仓库核对照片、配送现场情况、卖家同意降价…" />
          </Field>
          <button className="btn" disabled={busy} onClick={send}>发送</button>
        </div>
      </div>

      {block && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>
            配送改约单 {block.code}
            <span style={{ marginLeft: 8 }}><Badge map={BLOCK_STATUS} value={block.status} /></span>
            {block.buyerOption && <span className="badge blue" style={{ marginLeft: 6 }}>{BLOCK_OPTION[block.buyerOption]}</span>}
            {block.hoistStatus !== 'NONE' && <span style={{ marginLeft: 6 }}><Badge map={HOIST_STATUS} value={block.hoistStatus} /></span>}
            {block.hoistFailCause && <span style={{ marginLeft: 6 }}><Badge map={HOIST_FAIL_CAUSE} value={block.hoistFailCause} /></span>}
            <button className="btn sm" style={{ float: 'right' }} onClick={() => setOpenBlockId(block.id)}>进入改约单处理</button>
          </h3>
          <dl className="kv">
            <dt>现场勘测</dt>
            <dd>
              {block.siteFloor} 层 · 电梯进深 {block.elevatorDepthCm ?? '-'}cm（开门 {block.elevatorDoorCm ?? '-'}cm）
              · 楼梯转角 {block.stairTurnWidthCm ?? '-'}cm · {block.disassemblable ? '可拆装' : '不可拆装'}
              · 人工加价 <Money v={block.laborSurcharge} />
            </dd>
            <dt>方案附加费</dt><dd><Money v={block.optionFee} />（原配送费 <Money v={order?.deliveryFee} /> 之外）</dd>
            {block.buyerOption === 'HOIST' && block.hoistCompany && (
              <>
                <dt>吊装信息</dt>
                <dd>
                  {block.hoistCompany} · 物业{block.propertyPermit ? '已许可' : '未许可'} ·
                  天气「{block.weather}」· 保险{block.insuranceConfirmed ? '已确认' : '未确认'} ·
                  吊装费 <Money v={block.hoistQuote} />
                  {Number(block.thirdPartyClaimAmount) > 0 && <> · 第三方追偿 <Money v={block.thirdPartyClaimAmount} className="money-in" /></>}
                </dd>
              </>
            )}
            {block.buyerOption === 'RETURN' && (
              <>
                <dt>回库/二次上架</dt>
                <dd>{block.warehouseSlot || '尚未回仓'} · {block.status === 'RELISTED' ? '已二次上架' : block.status === 'CLOSED' ? '不再上架' : '待处理'}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      {showResolve && (
        <ResolveModal
          ticket={ticket}
          onClose={() => setShowResolve(false)}
          onResolved={() => {
            setShowResolve(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function ResolveModal({
  ticket,
  onClose,
  onResolved,
}: {
  ticket: any;
  onClose: () => void;
  onResolved: () => void;
}) {
  const [f, setF] = useState({
    resolution: 'PLATFORM_COMPENSATE',
    liableParty: 'PLATFORM',
    compensationAmount: 0,
    note: '',
    newPrice: undefined as number | undefined,
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    setBusy(true);
    try {
      await api(`/tickets/${ticket.id}/resolve`, {
        body: {
          resolution: f.resolution,
          liableParty: f.liableParty,
          compensationAmount: Number(f.compensationAmount || 0),
          note: f.note,
          newPrice: f.newPrice,
        },
      });
      toast('裁定已下达，订单/商品状态已联动');
      onResolved();
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>客服裁定 · {ticket.title}</h3>
        <Field label="处理结论">
          <select value={f.resolution} onChange={(e) => set('resolution', e.target.value)}>
            <option value="KEEP_LISTING">维持上架/继续履约</option>
            <option value="REDUCE_PRICE">降价处理（同步订单成交价）</option>
            <option value="SELLER_COMPENSATE">卖家承担赔付（从卖家应得扣除）</option>
            <option value="PLATFORM_COMPENSATE">平台承担赔付</option>
            <option value="RETURN_REFUND">退货退款</option>
            <option value="RE_LIST">退货返仓后重新上架</option>
            <option value="CANCEL_CONSIGNMENT">终止寄卖并下架</option>
          </select>
        </Field>
        {f.resolution === 'REDUCE_PRICE' && (
          <Field label="新价格（元）">
            <input type="number" onChange={(e) => set('newPrice', +e.target.value)} />
          </Field>
        )}
        <div className="row2">
          <Field label="责任方">
            <select value={f.liableParty} onChange={(e) => set('liableParty', e.target.value)}>
              <option value="SELLER">卖家</option>
              <option value="BUYER">买家</option>
              <option value="PLATFORM">平台</option>
              <option value="DELIVERY">配送</option>
              <option value="REFURBISHER">翻新师</option>
              <option value="SHARED">多方共担</option>
            </select>
          </Field>
          <Field label="赔付/扣款金额（元）">
            <input
              type="number"
              min={0}
              value={f.compensationAmount}
              onChange={(e) => set('compensationAmount', +e.target.value)}
            />
          </Field>
        </div>
        <Field label="裁定说明（将同步到协同记录与结算来源）">
          <textarea value={f.note} onChange={(e) => set('note', e.target.value)} />
        </Field>
        <div className="modal-foot">
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn" disabled={busy} onClick={submit}>确认裁定</button>
        </div>
      </div>
    </div>
  );
}
