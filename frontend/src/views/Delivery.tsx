import { useEffect, useState } from 'react';
import { api } from '../api';
import {
  Badge, Modal, Field, Money, Empty, toast,
} from '../ui';
import { DELIVERY_STATUS, FAIL_REASON, ORDER_STATUS, CATEGORY } from '../labels';
import { BlockListView } from './DeliveryBlock';

export function DeliveryView() {
  const [tab, setTab] = useState<'dispatch' | 'blocks'>('dispatch');
  return (
    <div>
      <div className="pill-filter" style={{ marginBottom: 12 }}>
        <button className={tab === 'dispatch' ? 'active' : ''} onClick={() => setTab('dispatch')}>配送调度</button>
        <button className={tab === 'blocks' ? 'active' : ''} onClick={() => setTab('blocks')}>大件受阻·改约单</button>
      </div>
      {tab === 'dispatch' ? <Dispatch onGoBlocks={() => setTab('blocks')} /> : <BlockListView />}
    </div>
  );
}

function Dispatch({ onGoBlocks }: { onGoBlocks: () => void }) {
  const [queue, setQueue] = useState<any[]>([]);
  const [orders, setOrders] = useState<Record<string, any>>({});
  const [items, setItems] = useState<any[]>([]);
  const [scheduleFor, setScheduleFor] = useState<any>(null);
  const [failFor, setFailFor] = useState<any>(null);
  const [surveyFor, setSurveyFor] = useState<any>(null);

  const load = async () => {
    const q = await api('/deliveries/queue');
    setQueue(q);
    const os = await api('/orders');
    setOrders(Object.fromEntries(os.map((o: any) => [o.id, o])));
    setItems(await api('/items'));
  };
  useEffect(() => {
    load();
  }, []);

  const act = async (orderId: string, action: string, body?: any, msg?: string) => {
    try {
      await api(`/deliveries/${orderId}/${action}`, body ? { body } : {});
      if (msg) toast(msg);
      load();
    } catch (e: any) {
      toast(e.message, true);
    }
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>配送调度</h2>
          <div className="sub">
            综合楼层、电梯、拆装、车辆、旧家具搬出与预约时间安排交付；到楼发现大件进不了电梯/楼道时
            <b>登记现场勘测</b>发起配送改约（照片/楼层/通道尺寸/拆装可能性/人工加价）
          </div>
        </div>
      </div>
      {queue.length === 0 ? (
        <Empty text="暂无待安排/异常配送任务" />
      ) : (
        <div className="grid grid-2">
          {queue.map((d) => {
            const order = orders[d.orderId];
            const item = items.find((i) => i.id === order?.itemId);
            return (
              <div className="card" key={d.id}>
                <h3>
                  订单 {order?.code || '?'}
                  {order && <span style={{ marginLeft: 8 }}><Badge map={ORDER_STATUS} value={order.status} /></span>}
                  <span style={{ marginLeft: 8 }}><Badge map={DELIVERY_STATUS} value={d.status} /></span>
                </h3>
                <div style={{ marginBottom: 6 }}>
                  {item && <b>{CATEGORY[item.category]} · {item.title}</b>}
                </div>
                <dl className="kv">
                  <dt>提货</dt>
                  <dd>{d.pickupFloor} 层 · {d.pickupElevator === 'ELEVATOR' ? '有电梯' : '无电梯'} · {d.needsDisassembly ? '需拆装' : '无需拆装'}</dd>
                  <dt>送达</dt>
                  <dd>{order?.buyerAddress || '-'} · {d.dropoffFloor} 层 · {d.dropoffElevator === 'ELEVATOR' ? '有电梯' : '无电梯'}</dd>
                  <dt>车辆</dt><dd>{d.vehicleType}</dd>
                  <dt>旧家具搬出</dt><dd>{d.oldFurnitureRemoval ? '是' : '否'}</dd>
                  <dt>预约时间</dt><dd>{d.scheduledWindow || '未预约'}</dd>
                  <dt>配送费</dt><dd>{order && <Money v={order.deliveryFee} />}{order && Number(order.surchargeFee) > 0 && <> + 改约附加 <Money v={order.surchargeFee} /></>}</dd>
                  {d.status === 'FAILED' && (
                    <>
                      <dt>失败原因</dt>
                      <dd><span className="badge red">{FAIL_REASON[d.failReason]}</span> {d.failNote}</dd>
                    </>
                  )}
                </dl>
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  {['PENDING', 'FAILED'].includes(d.status) && order?.status !== 'RESHEDULING' && (
                    <button className="btn sm" onClick={() => setScheduleFor(d)}>安排车辆/预约</button>
                  )}
                  {d.status === 'SCHEDULED' && (
                    <button className="btn sm" onClick={() => act(d.orderId, 'load', undefined, '已装车出库')}>装车出库</button>
                  )}
                  {['LOADED', 'SCHEDULED'].includes(d.status) && (
                    <>
                      <button className="btn ghost sm" onClick={() => act(d.orderId, 'done', { note: '' }, '已确认送达')}>正常送达</button>
                      <button className="btn danger sm" onClick={() => setFailFor(d)}>其他失败原因</button>
                      <button className="btn sm" onClick={() => setSurveyFor(d)}>到楼受阻·登记勘测</button>
                    </>
                  )}
                  {order?.status === 'RESHEDULING' && (
                    <span className="banner warn" style={{ margin: 0, padding: '6px 10px' }}>
                      已在配送改约流程中，请到「大件受阻·改约单」继续处理
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {scheduleFor && (
        <ScheduleModal delivery={scheduleFor} onClose={() => setScheduleFor(null)} onDone={() => { setScheduleFor(null); load(); }} />
      )}
      {failFor && (
        <FailModal delivery={failFor} onClose={() => setFailFor(null)} onDone={() => { setFailFor(null); load(); }} />
      )}
      {surveyFor && (
        <SurveyModal delivery={surveyFor} onClose={() => setSurveyFor(null)} onDone={() => { setSurveyFor(null); load(); onGoBlocks(); }} />
      )}
    </div>
  );
}

function ScheduleModal({ delivery, onClose, onDone }: { delivery: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    vehicleType: delivery.vehicleType || 'SMALL_VAN',
    scheduledWindow: delivery.scheduledWindow || '',
  });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!f.scheduledWindow) return toast('请填写预约时间段', true);
    setBusy(true);
    try {
      await api(`/deliveries/${delivery.orderId}/schedule`, { body: f });
      toast('排班成功');
      onDone();
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="安排配送"
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn" disabled={busy} onClick={submit}>确认排班</button>
        </>
      }
    >
      <Field label="车辆类型（按体积/拆装选择）">
        <select value={f.vehicleType} onChange={(e) => setF({ ...f, vehicleType: e.target.value })}>
          <option value="SMALL_VAN">小面包车（椅/书柜等小件）</option>
          <option value="MID_TRUCK">中货车（餐桌/儿童床）</option>
          <option value="LARGE_TRUCK">大货车（沙发/大柜，建议跟车 2 人）</option>
        </select>
      </Field>
      <Field label="预约时间段">
        <input placeholder="如 10-06 14:00-16:00" value={f.scheduledWindow} onChange={(e) => setF({ ...f, scheduledWindow: e.target.value })} />
      </Field>
      <div className="banner warn">
        提示：提货 {delivery.pickupFloor} 层（{delivery.pickupElevator === 'ELEVATOR' ? '电梯' : '无电梯'}）、
        送达 {delivery.dropoffFloor} 层（{delivery.dropoffElevator === 'ELEVATOR' ? '电梯' : '无电梯'}）
        {delivery.needsDisassembly ? '，家具需拆装，请安排翻新师或带工具。' : '。'}
        {delivery.oldFurnitureRemoval ? ' 本单含旧家具搬出。' : ''}
      </div>
    </Modal>
  );
}

function FailModal({ delivery, onClose, onDone }: { delivery: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ failReason: 'BUYER_ABSENT', failNote: '' });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/deliveries/${delivery.orderId}/fail`, { body: f });
      toast('已记录失败，可到协同工单发起客服介入');
      onDone();
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="登记配送失败"
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn danger" disabled={busy} onClick={submit}>确认失败</button>
        </>
      }
    >
      <Field label="失败原因（大件进不了电梯请改用「到楼受阻·登记勘测」以发起改约）">
        <select value={f.failReason} onChange={(e) => setF({ ...f, failReason: e.target.value })}>
          {Object.entries(FAIL_REASON)
            .filter(([k]) => !['NONE', 'ELEVATOR_TOO_SMALL', 'STAIR_TOO_NARROW', 'HOIST_FAILED'].includes(k))
            .map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
        </select>
      </Field>
      <Field label="现场情况说明">
        <textarea style={{ minHeight: 90 }} value={f.failNote} onChange={(e) => setF({ ...f, failNote: e.target.value })} />
      </Field>
    </Modal>
  );
}

function SurveyModal({ delivery, onClose, onDone }: { delivery: any; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    photos: '',
    siteFloor: delivery.dropoffFloor || 1,
    elevatorDepthCm: '' as number | '',
    elevatorWidthCm: '' as number | '',
    elevatorDoorCm: '' as number | '',
    stairWidthCm: '' as number | '',
    stairTurnWidthCm: '' as number | '',
    disassemblable: !!delivery.needsDisassembly,
    disassemblyNote: '',
    laborSurcharge: 0,
    siteNote: '',
  });
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!f.siteNote && f.elevatorDepthCm === '' && f.stairTurnWidthCm === '') {
      return toast('请至少记录电梯/楼梯尺寸或现场情况', true);
    }
    setBusy(true);
    try {
      const body: any = {
        photos: f.photos ? f.photos.split(/[,，\s]+/).filter(Boolean) : [],
        siteFloor: Number(f.siteFloor),
        disassemblable: f.disassemblable,
        disassemblyNote: f.disassemblyNote,
        laborSurcharge: Number(f.laborSurcharge || 0),
        siteNote: f.siteNote,
      };
      (['elevatorDepthCm', 'elevatorWidthCm', 'elevatorDoorCm', 'stairWidthCm', 'stairTurnWidthCm'] as const).forEach((k) => {
        if (f[k] !== '') body[k] = Number(f[k]);
      });
      await api(`/delivery-blocks/order/${delivery.orderId}/survey`, { body });
      toast('勘测已登记，配送改约单与协同工单已创建，等待买家选择方案');
      onDone();
    } catch (e: any) {
      toast(e.message, true);
    } finally {
      setBusy(false);
    }
  };

  const num = (k: any) => ({
    type: 'number' as const,
    value: f[k],
    onChange: (e: any) => set(k, e.target.value === '' ? '' : Number(e.target.value)),
  });

  return (
    <Modal
      wide
      title="到楼受阻·现场勘测登记"
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn danger" disabled={busy} onClick={submit}>提交勘测并发起改约</button>
        </>
      }
    >
      <div className="banner warn">
        提交后配送单标记失败、订单进入「配送改约中」，自动创建协同工单；买家可选择
        拆装上楼 / 吊装 / 退货 / 改送他址。
      </div>
      <div className="row2">
        <Field label="买家楼层">
          <input type="number" min={1} {...num('siteFloor')} />
        </Field>
        <Field label="电梯轿厢进深 cm">
          <input placeholder="如 140" {...num('elevatorDepthCm')} />
        </Field>
        <Field label="电梯轿厢宽度 cm">
          <input placeholder="如 150" {...num('elevatorWidthCm')} />
        </Field>
        <Field label="电梯开门净宽 cm">
          <input placeholder="如 85" {...num('elevatorDoorCm')} />
        </Field>
        <Field label="楼梯宽度 cm">
          <input {...num('stairWidthCm')} />
        </Field>
        <Field label="楼梯转角最小净宽 cm">
          <input placeholder="如 95" {...num('stairTurnWidthCm')} />
        </Field>
        <Field label="现场人工加价（元）">
          <input type="number" min={0} {...num('laborSurcharge')} />
        </Field>
      </div>
      <label className="checkline" style={{ marginBottom: 10 }}>
        <input type="checkbox" checked={f.disassemblable} onChange={(e) => set('disassemblable', e.target.checked)} />
        现场判断家具可以拆装上楼
      </label>
      <Field label="拆装评估（可拆部位、工时、复装风险）">
        <input value={f.disassemblyNote} onChange={(e) => set('disassemblyNote', e.target.value)} />
      </Field>
      <Field label="现场照片链接（卷尺测量/电梯铭牌/转角，逗号分隔）">
        <input value={f.photos} onChange={(e) => set('photos', e.target.value)} />
      </Field>
      <Field label="现场情况备注">
        <textarea style={{ minHeight: 80 }} value={f.siteNote} onChange={(e) => set('siteNote', e.target.value)}
          placeholder="如：三人沙发 2.25m，电梯进深仅 1.3m，楼梯转角 0.9m，立放/斜放均不可行" />
      </Field>
    </Modal>
  );
}
