import { useEffect, useState } from 'react';
import { api } from '../api';
import {
  Badge, Modal, Field, Money, Empty, toast,
} from '../ui';
import { DELIVERY_STATUS, FAIL_REASON, ORDER_STATUS, CATEGORY, RESCHEDULE_STATUS } from '../labels';
import { ReschedulePage } from './Reschedule';

export function DeliveryView() {
  const [queue, setQueue] = useState<any[]>([]);
  const [orders, setOrders] = useState<Record<string, any>>({});
  const [items, setItems] = useState<any[]>([]);
  const [reschedules, setReschedules] = useState<Record<string, any>>({});
  const [scheduleFor, setScheduleFor] = useState<any>(null);
  const [failFor, setFailFor] = useState<any>(null);
  const [reportFor, setReportFor] = useState<any>(null);
  const [rescheduleOrderId, setRescheduleOrderId] = useState<string | null>(null);

  const load = async () => {
    const q = await api('/deliveries/queue');
    setQueue(q);
    const os = await api('/orders');
    setOrders(Object.fromEntries(os.map((o: any) => [o.id, o])));
    setItems(await api('/items'));
    const rs = await api('/reschedules');
    setReschedules(Object.fromEntries(rs.map((r: any) => [r.orderId, r])));
  };
  useEffect(() => {
    load();
  }, []);

  if (rescheduleOrderId) {
    return <ReschedulePage orderId={rescheduleOrderId} onBack={() => { setRescheduleOrderId(null); load(); }} />;
  }

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
          <div className="sub">综合楼层、电梯、拆装、车辆、旧家具搬出与预约时间安排交付；失败必须记录原因（计入品类失败率）</div>
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
                  <dt>配送费</dt><dd>{order && <Money v={order.deliveryFee} />}</dd>
                  {d.status === 'FAILED' && (
                    <>
                      <dt>失败原因</dt>
                      <dd><span className="badge red">{FAIL_REASON[d.failReason]}</span> {d.failNote}</dd>
                    </>
                  )}
                </dl>
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  {['PENDING', 'FAILED'].includes(d.status) &&
                    !(reschedules[d.orderId] && ['RETURNED_TO_WAREHOUSE', 'RELISTED', 'CANCELLED'].includes(reschedules[d.orderId].status)) && (
                    <button className="btn sm" onClick={() => setScheduleFor(d)}>安排车辆/预约</button>
                  )}
                  {d.status === 'SCHEDULED' && (
                    <button className="btn sm" onClick={() => act(d.orderId, 'load', undefined, '已装车出库')}>装车出库</button>
                  )}
                  {['LOADED', 'SCHEDULED'].includes(d.status) && (
                    <>
                      <button className="btn ghost sm" onClick={() => act(d.orderId, 'done', { note: '' }, '已确认送达')}>正常送达</button>
                      <button className="btn danger sm" onClick={() => setFailFor(d)}>配送失败</button>
                    </>
                  )}
                  {['LOADED', 'SCHEDULED', 'FAILED', 'DONE'].includes(d.status) &&
                    (!reschedules[d.orderId] || ['COMPLETED', 'RELISTED', 'CANCELLED'].includes(reschedules[d.orderId].status)) && (
                      <button className="btn sm" onClick={() => setReportFor(d)}>🛗 进不了电梯·发起改约</button>
                    )}
                  {reschedules[d.orderId] &&
                    !['COMPLETED', 'RELISTED', 'CANCELLED', 'RETURNED_TO_WAREHOUSE'].includes(reschedules[d.orderId].status) && (
                      <button className="btn sm" onClick={() => setRescheduleOrderId(d.orderId)}>
                        处理配送改约 <Badge map={RESCHEDULE_STATUS} value={reschedules[d.orderId].status} />
                      </button>
                    )}
                  {reschedules[d.orderId]?.status === 'RETURNED_TO_WAREHOUSE' && (
                    <button className="btn ghost sm" onClick={() => setRescheduleOrderId(d.orderId)}>查看回库改约单</button>
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
      {reportFor && (
        <ReportSiteModal delivery={reportFor} onClose={() => setReportFor(null)} onDone={(orderId: string) => { setReportFor(null); setRescheduleOrderId(orderId); }} />
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
  const [f, setF] = useState({ failReason: 'ELEVATOR_TOO_SMALL', failNote: '' });
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
      <Field label="失败原因（进入品类配送失败率统计）">
        <select value={f.failReason} onChange={(e) => setF({ ...f, failReason: e.target.value })}>
          {Object.entries(FAIL_REASON).filter(([k]) => k !== 'NONE').map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </Field>
      <Field label="现场情况说明">
        <textarea style={{ minHeight: 90 }} value={f.failNote} onChange={(e) => setF({ ...f, failNote: e.target.value })}
          placeholder="如：电梯进深 1.4m，沙发 2.4m 不可拆装；建议同步发起协同工单" />
      </Field>
    </Modal>
  );
}

function ReportSiteModal({ delivery, onClose, onDone }: {
  delivery: any; onClose: () => void; onDone: (orderId: string) => void;
}) {
  const [f, setF] = useState({
    sitePhotos: '',
    siteFloor: delivery.dropoffFloor || 1,
    elevatorDepth: 1.4,
    elevatorDoorWidth: 0.9,
    stairLandingWidth: 1.2,
    furnitureMaxSide: 2.3,
    disassemblyFeasibility: delivery.needsDisassembly ? 'DISASSEMBLABLE' : 'NOT_DISASSEMBLABLE',
    laborSurcharge: 120,
    siteNote: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/reschedules/deliveries/${delivery.orderId}/report`, {
        body: {
          ...f,
          sitePhotos: f.sitePhotos ? f.sitePhotos.split(/[,，\s]+/).filter(Boolean) : [],
        },
      });
      toast('现场已登记，已自动发起协同工单并通知买家选择方案');
      onDone(delivery.orderId);
    } catch (e: any) {
      toast(e.message, true);
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title="现场登记 · 家具进不了电梯/楼道"
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn danger" disabled={busy} onClick={submit}>提交并发起配送改约</button>
        </>
      }
    >
      <div className="row2">
        <Field label="现场照片链接（逗号分隔：电梯门/轿厢、楼梯转角、家具对比）">
          <input value={f.sitePhotos} onChange={(e) => set('sitePhotos', e.target.value)} placeholder="http://…/elevator.jpg, http://…/stair.jpg" />
        </Field>
        <Field label="买家楼层">
          <input type="number" min={1} value={f.siteFloor} onChange={(e) => set('siteFloor', +e.target.value)} />
        </Field>
        <Field label="电梯轿厢进深（米，无梯填 0）">
          <input type="number" step="0.01" min={0} value={f.elevatorDepth} onChange={(e) => set('elevatorDepth', +e.target.value)} />
        </Field>
        <Field label="电梯门宽（米）">
          <input type="number" step="0.01" min={0} value={f.elevatorDoorWidth} onChange={(e) => set('elevatorDoorWidth', +e.target.value)} />
        </Field>
        <Field label="楼梯转角最小宽（米，不能过填实测值）">
          <input type="number" step="0.01" min={0} value={f.stairLandingWidth} onChange={(e) => set('stairLandingWidth', +e.target.value)} />
        </Field>
        <Field label="家具最大边（米）">
          <input type="number" step="0.01" min={0} value={f.furnitureMaxSide} onChange={(e) => set('furnitureMaxSide', +e.target.value)} />
        </Field>
        <Field label="拆装可能性">
          <select value={f.disassemblyFeasibility} onChange={(e) => set('disassemblyFeasibility', e.target.value)}>
            <option value="DISASSEMBLABLE">可拆装（拆扶手/拆脚后可进梯）</option>
            <option value="PARTIAL">仅部分可拆</option>
            <option value="NOT_DISASSEMBLABLE">不可拆装</option>
          </select>
        </Field>
        <Field label="现场人工加价（元，拆装/加人费用）">
          <input type="number" min={0} value={f.laborSurcharge} onChange={(e) => set('laborSurcharge', +e.target.value)} />
        </Field>
      </div>
      <Field label="现场情况说明">
        <textarea style={{ minHeight: 80 }} value={f.siteNote} onChange={(e) => set('siteNote', e.target.value)}
          placeholder="如：拆扶手需加 1 人约 40 分钟；高层可评估吊装；物业对吊装需提前报备" />
      </Field>
      <div className="banner warn">
        提交后：配送任务标记失败（计入品类失败率），订单进入「配送改约中」，
        买家可选择拆装上楼 / 吊装 / 退货 / 改送其他地址；吊装失败需定责（买家环境 / 方案误判 / 第三方）。
      </div>
    </Modal>
  );
}
