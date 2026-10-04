import { useEffect, useState } from 'react';
import { api, getUser } from '../api';
import {
  Badge, Modal, Field, Money, Empty, toast,
} from '../ui';
import {
  CATEGORY,
  RESCHEDULE_STATUS,
  RESCHEDULE_PLAN,
  PLAN_STATUS,
  DISASSEMBLY_FEASIBILITY,
  HOIST_LIABILITY,
} from '../labels';

/**
 * 配送改约共享视图：现场记录、四方案选择、吊装四项确认与失败三分类定责、
 * 回库登记、二次上架、改地址二次排班。买家/配送/仓库/客服按角色出现不同操作。
 */
export function ReschedulePage({
  id,
  orderId,
  onBack,
}: {
  id?: string;
  orderId?: string;
  onBack: () => void;
}) {
  return (
    <div>
      <div className="page-head">
        <div>
          <button className="btn ghost sm" onClick={onBack}>← 返回</button>
          <h2 style={{ marginTop: 10 }}>配送改约</h2>
          <div className="sub">家具进不了电梯/楼道后的方案协同：拆装 / 吊装 / 退货 / 改送其他地址</div>
        </div>
      </div>
      <RescheduleBody id={id} orderId={orderId} onChanged={onBack} />
    </div>
  );
}

export function RescheduleModal({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <Modal wide title="配送改约处理" onClose={onClose}>
      <RescheduleBody id={id} onChanged={onClose} />
    </Modal>
  );
}

export function RescheduleBody({
  id,
  orderId,
  onChanged,
}: {
  id?: string;
  orderId?: string;
  onChanged: () => void;
}) {
  const me = getUser()!;
  const [data, setData] = useState<any>(null);
  const [action, setAction] = useState('');
  const [tick, setTick] = useState(0);

  const load = () =>
    api(orderId ? `/reschedules/order/${orderId}` : `/reschedules/${id}`).then(setData);
  useEffect(() => {
    load();
  }, [id, orderId, tick]);

  if (!data) return <Empty text="加载中…" />;
  const { reschedule: rs, plans, order, item } = data;
  const staff = ['DELIVERY', 'CS', 'OPS', 'ADMIN'].includes(me.role);
  const warehouse = ['WAREHOUSE', 'OPS', 'ADMIN'].includes(me.role);
  const buyer = me.role === 'BUYER';
  const refresh = () => {
    setAction('');
    setTick((t) => t + 1);
  };

  const openPlan = [...plans]
    .reverse()
    .find((p: any) => ['PENDING', 'CONFIRMED', 'EXECUTING'].includes(p.status));

  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>
          订单 {order?.code} · {item && `${CATEGORY[item.category]} · ${item.title}`}
          <span style={{ marginLeft: 8 }}><Badge map={RESCHEDULE_STATUS} value={rs.status} /></span>
        </h3>
        <dl className="kv">
          <dt>受阻地址</dt>
          <dd>{order?.buyerAddress} · {rs.siteFloor} 层</dd>
          <dt>现场测量</dt>
          <dd>
            电梯进深 {rs.elevatorDepth}m / 门宽 {rs.elevatorDoorWidth}m ·
            楼梯转角 {rs.stairLandingWidth}m · 家具最大边 {rs.furnitureMaxSide}m
          </dd>
          <dt>拆装可能性</dt>
          <dd>
            <span className="badge blue">{DISASSEMBLY_FEASIBILITY[rs.disassemblyFeasibility] || rs.disassemblyFeasibility}</span>
          </dd>
          <dt>现场人工加价</dt><dd><Money v={rs.laborSurcharge} /></dd>
          <dt>现场照片</dt>
          <dd>
            {(rs.sitePhotos || []).length === 0 && <span className="muted">无</span>}
            {rs.sitePhotos?.map((p: string, i: number) => (
              <span className="tag" key={i} title={p}>📷 {p.split('/').pop()}</span>
            ))}
          </dd>
          {rs.siteNote && (
            <>
              <dt>现场说明</dt><dd>{rs.siteNote}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>费用与责任</h3>
          <dl className="kv">
            <dt>拆装费</dt><dd><Money v={rs.disassemblyFee} /></dd>
            <dt>吊装费</dt><dd><Money v={rs.hoistingFee} /></dd>
            <dt>吊装失败已发生费</dt><dd><Money v={rs.hoistingFailureCost} /></dd>
            {rs.hoistingFailureLiability && (
              <>
                <dt>吊装失败定责</dt>
                <dd><span className="badge red">{HOIST_LIABILITY[rs.hoistingFailureLiability]}</span></dd>
              </>
            )}
            <dt>第三方赔付</dt><dd><Money v={rs.thirdPartyCompensation} /></dd>
            <dt>回程运费 / 回库费</dt>
            <dd><Money v={rs.returnFreight} /> / <Money v={rs.restockingFee} /></dd>
            <dt>二次配送费</dt><dd><Money v={rs.redeliveryFee} /></dd>
            <dt>回库库位</dt>
            <dd>{rs.returnWarehouseSlot || '-'} {rs.relisted && <span className="badge green" style={{ marginLeft: 6 }}>已二次上架</span>}</dd>
          </dl>
          {rs.hoistingCompany && (
            <div className="banner info" style={{ marginTop: 8 }}>
              吊装：{rs.hoistingCompany}｜物业许可：{rs.propertyPermit}｜天气：{rs.weatherCondition}｜保险：{rs.insuranceConfirmation}
            </div>
          )}
        </div>

        <div className="card">
          <h3>方案演进</h3>
          {plans.length === 0 && <div className="muted">买家尚未选择方案</div>}
          <div className="chat">
            {plans.map((p: any) => (
              <div key={p.id} className="msg" style={{ marginBottom: 8 }}>
                <div className="mh">
                  <b>{RESCHEDULE_PLAN[p.plan]}</b>
                  <Badge map={PLAN_STATUS} value={p.status} />
                  {Number(p.quotedFee) > 0 && <Money v={p.quotedFee} className="price" />}
                </div>
                <div className="mc">
                  {p.plan === 'CHANGE_ADDRESS' && p.newAddress && (
                    <div>新地址：{p.newAddress}（{p.newFloor} 层{p.newElevator === 'ELEVATOR' ? '·有电梯' : '·无电梯'}）</div>
                  )}
                  {p.plan === 'HOISTING' && p.hoistingCompany && (
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {p.hoistingCompany}｜物业 {p.propertyPermit}｜{p.weatherCondition}｜保险 {p.insuranceConfirmation}
                    </div>
                  )}
                  {p.failureLiability && (
                    <div><span className="badge red">{HOIST_LIABILITY[p.failureLiability]}</span> 损失 ¥{p.failureCost}{Number(p.thirdPartyCompensation) > 0 && `｜第三方认赔 ¥${p.thirdPartyCompensation}`}</div>
                  )}
                  {p.failureNote && <div className="muted">{p.failureNote}</div>}
                  {p.note && <div className="muted">{p.note}</div>}
                  <div className="muted" style={{ fontSize: 12 }}>{new Date(p.createdAt).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 按角色与状态的操作区 */}
      <div className="card" style={{ marginTop: 12 }}>
        <h3>处理操作</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {rs.status === 'BLOCKED' && (buyer || me.role === 'CS' || me.role === 'OPS' || me.role === 'ADMIN') && (
            <button className="btn" onClick={() => setAction('choose')}>选择改约方案</button>
          )}
          {rs.status === 'IN_PROGRESS' && openPlan?.plan === 'DISASSEMBLY' && staff && (
            <button className="btn" onClick={() => setAction('disasm-done')}>拆装上楼完成送达</button>
          )}
          {rs.status === 'AWAITING_HOIST_CONFIRM' && staff && (
            <button className="btn" onClick={() => setAction('hoist-confirm')}>吊装四项确认并报价</button>
          )}
          {rs.status === 'HOISTING' && staff && (
            <>
              <button className="btn" onClick={() => setAction('hoist-ok')}>吊装成功送达</button>
              <button className="btn danger" onClick={() => setAction('hoist-fail')}>吊装失败并定责</button>
            </>
          )}
          {rs.status === 'RESCHEDULED' && staff && (
            <button className="btn" onClick={() => setAction('redeliver')}>按新地址排班二次配送</button>
          )}
          {rs.status === 'REDELIVERING' && staff && (
            <button className="btn" onClick={() => setAction('redeliver-done')}>二次配送正常送达</button>
          )}
          {rs.status === 'IN_PROGRESS' && openPlan?.plan === 'RETURN' && (staff || warehouse) && (
            <button className="btn" onClick={() => setAction('return')}>家具回库登记</button>
          )}
          {rs.status === 'RETURNED_TO_WAREHOUSE' && warehouse && (
            <button className="btn" onClick={() => setAction('relist')}>复检后二次上架</button>
          )}
          {['COMPLETED', 'RELISTED'].includes(rs.status) && (
            <span className="badge green">该改约单已完结</span>
          )}
        </div>
      </div>

      {action === 'choose' && <ChoosePlanModal rs={rs} onClose={refresh} />}
      {action === 'hoist-confirm' && <HoistConfirmModal id={rs.id} onClose={refresh} />}
      {action === 'hoist-fail' && <HoistFailModal id={rs.id} onClose={refresh} />}
      {action === 'return' && <WarehouseReturnModal id={rs.id} onClose={refresh} />}
      {action === 'relist' && <RelistModal id={rs.id} item={item} onClose={refresh} />}
      {action === 'redeliver' && <RedeliverModal id={rs.id} onClose={refresh} />}
      {action === 'disasm-done' && (
        <ConfirmAction
          title="确认拆装上楼完成"
          text={`将按方案收取拆装/人力加价 ¥${rs.laborSurcharge}，订单标记送达。`}
          run={() => api(`/reschedules/${rs.id}/disassembly/complete`, { body: {} })}
          onClose={refresh}
        />
      )}
      {action === 'hoist-ok' && (
        <ConfirmAction
          title="确认吊装成功"
          text={`吊装作业成功，家具送达。将按吊装报价 ¥${rs.hoistingFee} 结算。`}
          run={() => api(`/reschedules/${rs.id}/hoisting/success`, { body: {} })}
          onClose={refresh}
        />
      )}
      {action === 'redeliver-done' && (
        <ConfirmAction
          title="确认二次配送送达"
          text="新地址二次配送已正常签收，改约单完结。"
          run={() => api(`/deliveries/${rs.orderId}/done`, { body: {} })}
          onClose={refresh}
        />
      )}
    </div>
  );
}

function ConfirmAction({ title, text, run, onClose }: {
  title: string; text: string; run: () => Promise<any>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const doIt = async () => {
    setBusy(true);
    try {
      await run();
      toast('操作成功');
      onClose();
    } catch (e: any) {
      toast(e.message, true);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn" disabled={busy} onClick={doIt}>确认</button>
        </>
      }
    >
      <div className="banner info">{text}</div>
    </Modal>
  );
}

function ChoosePlanModal({ rs, onClose }: { rs: any; onClose: () => void }) {
  const [f, setF] = useState({
    plan: rs.disassemblyFeasibility === 'NOT_DISASSEMBLABLE' ? 'HOISTING' : 'DISASSEMBLY',
    newAddress: '', newFloor: 1, newElevator: 'ELEVATOR', note: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const redeliverFee = f.plan === 'CHANGE_ADDRESS'
    ? 60 + (f.newElevator !== 'ELEVATOR' ? Math.max(0, f.newFloor - 1) * 15 : 0)
    : 0;

  const submit = async () => {
    setBusy(true);
    try {
      await api(`/reschedules/${rs.id}/choose-plan`, { body: f });
      toast('方案已提交，相关方可在协同工单看到进度');
      onClose();
    } catch (e: any) {
      toast(e.message, true);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="选择改约方案"
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn" disabled={busy} onClick={submit}>确认选择</button>
        </>
      }
    >
      <Field label="处理方案">
        <select value={f.plan} onChange={(e) => set('plan', e.target.value)}>
          {rs.disassemblyFeasibility === 'NOT_DISASSEMBLABLE'
            ? <option value="HOISTING">吊装上楼</option>
            : <option value="DISASSEMBLY">拆装上楼（现场加价 ¥{rs.laborSurcharge}）</option>}
          <option value="HOISTING">吊装上楼（需公司/物业/天气/保险四项确认）</option>
          <option value="RETURN">退货回库（全额退款，仓库复检后可能二次上架）</option>
          <option value="CHANGE_ADDRESS">改送其他地址（二次配送费按新地址计）</option>
        </select>
      </Field>
      {f.plan === 'CHANGE_ADDRESS' && (
        <div className="row2">
          <Field label="新收货地址">
            <input value={f.newAddress} onChange={(e) => set('newAddress', e.target.value)} placeholder="小区+门牌" />
          </Field>
          <Field label="楼层">
            <input type="number" min={1} value={f.newFloor} onChange={(e) => set('newFloor', +e.target.value)} />
          </Field>
          <Field label="电梯条件">
            <select value={f.newElevator} onChange={(e) => set('newElevator', e.target.value)}>
              <option value="ELEVATOR">有电梯</option>
              <option value="NO_ELEVATOR">无电梯</option>
              <option value="WALKUP">楼梯房</option>
            </select>
          </Field>
          <Field label="二次配送费预估">
            <div className="price">¥{redeliverFee}</div>
          </Field>
        </div>
      )}
      {f.plan === 'HOISTING' && (
        <div className="banner warn">
          选择吊装后，配送需确认：吊装公司、物业许可、作业天气、保险四项后方可施工；
          若吊装失败，平台会区分买家环境限制、配送方案误判、第三方责任。
        </div>
      )}
      {f.plan === 'RETURN' && (
        <div className="banner warn">退货后家具回库复检，可能产生二次上架；回程运费等已发生成本按定责分流。</div>
      )}
      <Field label="备注">
        <textarea value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="可选，给配送/客服的说明" />
      </Field>
    </Modal>
  );
}

function HoistConfirmModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [f, setF] = useState({
    hoistingCompany: '', propertyPermit: '', weatherCondition: '',
    insuranceConfirmation: '', hoistingFee: 300,
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/reschedules/${id}/hoisting/confirm`, { body: f });
      toast('吊装确认完成，可开始作业');
      onClose();
    } catch (e: any) {
      toast(e.message, true);
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title="吊装前置确认（四项齐全方可作业）"
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn" disabled={busy} onClick={submit}>确认并开始吊装</button>
        </>
      }
    >
      <div className="row2">
        <Field label="吊装公司">
          <input value={f.hoistingCompany} onChange={(e) => set('hoistingCompany', e.target.value)} placeholder="如 安捷高空吊装 王队 138xxxx" />
        </Field>
        <Field label="物业许可（批文编号/许可照片链接）">
          <input value={f.propertyPermit} onChange={(e) => set('propertyPermit', e.target.value)} placeholder="如 物业许可单 WY-20261003" />
        </Field>
        <Field label="天气情况（风速/降雨/作业窗口）">
          <input value={f.weatherCondition} onChange={(e) => set('weatherCondition', e.target.value)} placeholder="如 晴 风力2级 14:00-16:00" />
        </Field>
        <Field label="保险确认（保单号/承保额度）">
          <input value={f.insuranceConfirmation} onChange={(e) => set('insuranceConfirmation', e.target.value)} placeholder="如 平安吊装险 PA-88 保额5万" />
        </Field>
        <Field label="吊装费报价（元，向买家收取）">
          <input type="number" min={1} value={f.hoistingFee} onChange={(e) => set('hoistingFee', +e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function HoistFailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [f, setF] = useState({
    failureLiability: 'THIRD_PARTY',
    failureCost: 0,
    thirdPartyCompensation: 0,
    failureNote: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/reschedules/${id}/hoisting/fail`, { body: f });
      toast('已记录吊装失败与定责，买家可重新选择方案');
      onClose();
    } catch (e: any) {
      toast(e.message, true);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="吊装失败登记与定责"
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn danger" disabled={busy} onClick={submit}>确认失败</button>
        </>
      }
    >
      <Field label="失败责任分类">
        <select value={f.failureLiability} onChange={(e) => set('failureLiability', e.target.value)}>
          <option value="BUYER_ENVIRONMENT">买家环境限制（承重锚点缺失/窗户不可拆/物业临时禁止等）</option>
          <option value="PLAN_MISJUDGMENT">配送方案误判（勘测/选案错误，本可拆装或走楼梯）</option>
          <option value="THIRD_PARTY">第三方责任（吊装公司操作事故/设备故障/爽约）</option>
        </select>
      </Field>
      <div className="row2">
        <Field label="已发生的吊装/进场费用（元）">
          <input type="number" min={0} value={f.failureCost} onChange={(e) => set('failureCost', +e.target.value)} />
        </Field>
        {f.failureLiability === 'THIRD_PARTY' && (
          <Field label="吊装公司认赔金额（元）">
            <input type="number" min={0} value={f.thirdPartyCompensation} onChange={(e) => set('thirdPartyCompensation', +e.target.value)} />
          </Field>
        )}
      </div>
      <Field label="失败情况说明">
        <textarea style={{ minHeight: 90 }} value={f.failureNote} onChange={(e) => set('failureNote', e.target.value)}
          placeholder="如：12 楼外墙无承重锚点，物业不允许打孔（买家环境）；或吊带滑脱剐蹭（第三方）" />
      </Field>
      <div className="banner warn">
        费用分流：买家环境限制 → 买家承担；方案误判 → 平台吸收；第三方 → 平台先担、第三方赔付冲抵。
      </div>
    </Modal>
  );
}

function WarehouseReturnModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [f, setF] = useState({ warehouseSlot: '', returnFreight: 80, restockingFee: 40, note: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/reschedules/${id}/warehouse-return`, { body: f });
      toast('回库已登记，订单退货完结，等待复检上架');
      onClose();
    } catch (e: any) {
      toast(e.message, true);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="退货家具回库登记"
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn" disabled={busy} onClick={submit}>确认回库</button>
        </>
      }
    >
      <div className="row2">
        <Field label="回库库位">
          <input value={f.warehouseSlot} onChange={(e) => set('warehouseSlot', e.target.value)} placeholder="如 A-05-01" />
        </Field>
        <Field label="回程运费（元，平台吸收）">
          <input type="number" min={0} value={f.returnFreight} onChange={(e) => set('returnFreight', +e.target.value)} />
        </Field>
        <Field label="回库复检/入库费（元）">
          <input type="number" min={0} value={f.restockingFee} onChange={(e) => set('restockingFee', +e.target.value)} />
        </Field>
      </div>
      <Field label="回库备注（外观/复检初步情况）">
        <textarea value={f.note} onChange={(e) => set('note', e.target.value)} />
      </Field>
    </Modal>
  );
}

function RelistModal({ id, item, onClose }: { id: string; item: any; onClose: () => void }) {
  const [f, setF] = useState({
    listedPrice: Number(item?.listedPrice || 0),
    description: item?.description || '',
    photos: (item?.photos || []).join(','),
    deliveryRadiusKm: Number(item?.deliveryRadiusKm || 0),
  });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/reschedules/${id}/relist`, {
        body: {
          ...f,
          photos: f.photos ? f.photos.split(/[,，\s]+/).filter(Boolean) : [],
        },
      });
      toast('已二次上架');
      onClose();
    } catch (e: any) {
      toast(e.message, true);
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title="回库复检 · 二次上架"
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn" disabled={busy} onClick={submit}>确认二次上架</button>
        </>
      }
    >
      <div className="row2">
        <Field label="挂牌价（元）">
          <input type="number" min={0} value={f.listedPrice} onChange={(e) => set('listedPrice', +e.target.value)} />
        </Field>
        <Field label="可配送范围（公里，0=仅同城自提）">
          <input type="number" min={0} value={f.deliveryRadiusKm} onChange={(e) => set('deliveryRadiusKm', +e.target.value)} />
        </Field>
        <Field label="照片链接（逗号分隔）">
          <input value={f.photos} onChange={(e) => set('photos', e.target.value)} />
        </Field>
      </div>
      <Field label="上架描述（补充最小通道/电梯尺寸要求，避免再次受阻）">
        <textarea style={{ minHeight: 100 }} value={f.description} onChange={(e) => set('description', e.target.value)} />
      </Field>
    </Modal>
  );
}

function RedeliverModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [f, setF] = useState({ scheduledWindow: '', vehicleType: 'MID_TRUCK' });
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!f.scheduledWindow) return toast('请填写预约时间', true);
    setBusy(true);
    try {
      await api(`/reschedules/${id}/redelivery/schedule`, { body: f });
      toast('二次配送已排班');
      onClose();
    } catch (e: any) {
      toast(e.message, true);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="改地址 · 二次配送排班"
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn" disabled={busy} onClick={submit}>确认排班</button>
        </>
      }
    >
      <div className="row2">
        <Field label="预约时间段">
          <input placeholder="如 10-06 上午" value={f.scheduledWindow} onChange={(e) => setF({ ...f, scheduledWindow: e.target.value })} />
        </Field>
        <Field label="车辆类型">
          <select value={f.vehicleType} onChange={(e) => setF({ ...f, vehicleType: e.target.value })}>
            <option value="SMALL_VAN">小面包车</option>
            <option value="MID_TRUCK">中货车</option>
            <option value="LARGE_TRUCK">大货车</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

/** 供其他页面按 orderId 探测改约单（404 返回 null） */
export async function fetchRescheduleByOrder(orderId: string): Promise<any | null> {
  try {
    return await api(`/reschedules/order/${orderId}`);
  } catch {
    return null;
  }
}
