import { useEffect, useState } from 'react';
import { api, getUser } from '../api';
import {
  Badge, Modal, Field, Money, Empty, toast,
} from '../ui';
import {
  BLOCK_STATUS, BLOCK_OPTION, HOIST_STATUS, HOIST_FAIL_CAUSE,
  RELIST_DECISION, CATEGORY, ORDER_STATUS, DELIVERY_STATUS, FAIL_REASON,
} from '../labels';

/** 各角色的配送改约工作台列表 */
export function BlockListView({ scope }: { scope?: 'staff' | 'warehouse' }) {
  const [blocks, setBlocks] = useState<any[]>([]);
  const [orders, setOrders] = useState<Record<string, any>>({});
  const [items, setItems] = useState<any[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState('OPEN');

  const load = async () => {
    const [bs, os, its] = await Promise.all([
      api('/delivery-blocks'),
      api('/orders'),
      api('/items'),
    ]);
    setBlocks(bs);
    setOrders(Object.fromEntries(os.map((o: any) => [o.id, o])));
    setItems(its);
  };
  useEffect(() => {
    load();
  }, []);

  if (openId) return <BlockDetail id={openId} onBack={() => { setOpenId(null); load(); }} />;

  const warehouseFlow = (b: any) =>
    ['RETURN_DECIDED', 'WAREHOUSED'].includes(b.status);
  const shown = blocks.filter((b) => {
    if (scope === 'warehouse') return warehouseFlow(b);
    if (filter === 'ALL') return true;
    if (filter === 'OPEN') return !['DELIVERED', 'RELISTED', 'CLOSED'].includes(b.status);
    if (filter === 'DELIVERED') return b.status === 'DELIVERED';
    if (filter === 'RETURN') return ['RETURN_DECIDED', 'WAREHOUSED', 'RELISTED', 'CLOSED'].includes(b.status);
    return true;
  });

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>大件受阻 · 配送改约</h2>
          <div className="sub">
            现场勘测（照片/楼层/通道尺寸/拆装可能性/人工加价）→ 买家四方案 →
            吊装（公司/许可/天气/保险，失败三归因）→ 退货回库与二次上架决策
          </div>
        </div>
      </div>
      {scope !== 'warehouse' && (
        <div className="pill-filter">
          {[['OPEN', '处理中'], ['RETURN', '退货回库'], ['DELIVERED', '改约送达'], ['ALL', '全部']].map(([k, v]) => (
            <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>{v}</button>
          ))}
        </div>
      )}
      {shown.length === 0 ? (
        <Empty text={scope === 'warehouse' ? '暂无待回库/待上架决策的改约单' : '暂无配送改约单'} />
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>改约单</th><th>商品/订单</th><th>状态</th><th>买家方案</th>
                  <th>吊装</th><th>附加费</th><th>回库/二次上架</th><th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((b) => {
                  const order = orders[b.orderId];
                  const item = items.find((i) => i.id === b.itemId);
                  return (
                    <tr key={b.id}>
                      <td><b>{b.code}</b><div className="hint">{order?.code}</div></td>
                      <td>
                        {item ? `${CATEGORY[item.category]} · ${item.title}` : '-'}
                        <div className="hint">{order?.buyerAddress}</div>
                      </td>
                      <td><Badge map={BLOCK_STATUS} value={b.status} /></td>
                      <td>{b.buyerOption ? BLOCK_OPTION[b.buyerOption] : <span className="muted">待选择</span>}</td>
                      <td>
                        {b.hoistStatus !== 'NONE' ? (
                          <>
                            <Badge map={HOIST_STATUS} value={b.hoistStatus} />
                            {b.hoistFailCause && (
                              <div><Badge map={HOIST_FAIL_CAUSE} value={b.hoistFailCause} /></div>
                            )}
                          </>
                        ) : '-'}
                      </td>
                      <td><Money v={b.optionFee} /></td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {b.buyerOption === 'RETURN'
                          ? `${b.warehouseSlot || '未回仓'} · ${RELIST_DECISION[b.relistDecision]}`
                          : '—'}
                      </td>
                      <td><button className="btn sm" onClick={() => setOpenId(b.id)}>进入处理</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** 改送他址转运附加费预估（与后端一致）：基础 ¥100 + 无电梯 ¥15/层 */
export function changeAddressFee(floor: number, elevator: string) {
  let fee = 100;
  if (elevator !== 'ELEVATOR') fee += Math.max(0, (Number(floor) || 1) - 1) * 15;
  return fee;
}

export function BlockDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const me = getUser()!;
  const [data, setData] = useState<any>(null);
  const [showOption, setShowOption] = useState(false);
  const [showHoist, setShowHoist] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [showReturn, setShowReturn] = useState(false);
  const [showRelist, setShowRelist] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => api(`/delivery-blocks/${id}`).then(setData);
  useEffect(() => {
    load();
  }, [id]);

  if (!data) return <div className="empty">加载中…</div>;
  const { block, order, item, delivery } = data;

  const isStaff = ['CS', 'OPS', 'ADMIN'].includes(me.role);
  const isDelivery = ['DELIVERY', 'CS', 'OPS', 'ADMIN'].includes(me.role);
  const isWarehouse = ['WAREHOUSE', 'CS', 'OPS', 'ADMIN'].includes(me.role);
  const isBuyer = me.role === 'BUYER';

  const act = async (path: string, body: any, okMsg: string) => {
    setBusy(true);
    try {
      await api(`/delivery-blocks/${block.id}/${path}`, { body });
      toast(okMsg);
      await load();
      return true;
    } catch (e: any) {
      toast(e.message, true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const canChoose =
    (isBuyer || isStaff) &&
    ['SURVEYED', 'RESOLVING', 'RETURN_DECIDED'].includes(block.status) &&
    block.hoistStatus !== 'SUCCESS';
  const canArrangeHoist =
    isDelivery &&
    block.buyerOption === 'HOIST' &&
    ['NONE', 'FAILED'].includes(block.hoistStatus) &&
    !['DELIVERED', 'RELISTED', 'CLOSED'].includes(block.status);
  const canReportHoist = isDelivery && block.hoistStatus === 'SCHEDULED';
  const canComplete =
    isDelivery &&
    block.status === 'RESOLVING' &&
    (block.buyerOption === 'DISASSEMBLY' ||
      (block.buyerOption === 'HOIST' && block.hoistStatus === 'SUCCESS') ||
      block.buyerOption === 'CHANGE_ADDRESS');
  const canReturn =
    isWarehouse && block.buyerOption === 'RETURN' && block.status === 'RETURN_DECIDED';
  const canRelist = isWarehouse && block.status === 'WAREHOUSED';

  return (
    <div>
      <div className="page-head">
        <div>
          <button className="btn ghost sm" onClick={onBack}>← 返回</button>
          <h2 style={{ marginTop: 10 }}>
            配送改约单 {block.code}
            <span style={{ marginLeft: 10 }}><Badge map={BLOCK_STATUS} value={block.status} /></span>
            {block.buyerOption && (
              <span className="badge blue" style={{ marginLeft: 6 }}>{BLOCK_OPTION[block.buyerOption]}</span>
            )}
          </h2>
          <div className="sub">
            {item && `${CATEGORY[item.category]} · ${item.title}`}
            {order && ` · 订单 ${order.code} `}
            {order && <Badge map={ORDER_STATUS} value={order.status} />}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canChoose && <button className="btn" onClick={() => setShowOption(true)}>{block.buyerOption ? '改选方案' : '选择配送方案'}</button>}
          {canArrangeHoist && <button className="btn" onClick={() => setShowHoist(true)}>安排吊装</button>}
          {canReportHoist && (
            <>
              <button className="btn" disabled={busy} onClick={() => act('hoist-result', { success: true }, '吊装成功，可办理交付')}>回填吊装成功</button>
              <button className="btn danger" onClick={() => setShowResult(true)}>回填吊装失败</button>
            </>
          )}
          {canComplete && <button className="btn" disabled={busy} onClick={() => act('complete-delivery', { note: '' }, '改约方案已交付完成')}>完成交付</button>}
          {canReturn && <button className="btn" onClick={() => setShowReturn(true)}>退货回库登记</button>}
          {canRelist && <button className="btn" onClick={() => setShowRelist(true)}>二次上架决策</button>}
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>现场勘测（配送员到楼下登记）</h3>
          <dl className="kv">
            <dt>现场照片</dt>
            <dd>
              {block.photos?.length
                ? block.photos.map((p: string, i: number) => (
                    <span className="tag" key={i} style={{ marginRight: 4 }}>📷 {String(p).split('/').pop()}</span>
                  ))
                : '无'}
            </dd>
            <dt>买家楼层</dt><dd>{block.siteFloor} 层</dd>
            <dt>电梯尺寸</dt>
            <dd>
              进深 {block.elevatorDepthCm ?? '-'} cm · 宽 {block.elevatorWidthCm ?? '-'} cm
              · 开门净宽 {block.elevatorDoorCm ?? '-'} cm
            </dd>
            <dt>楼梯</dt>
            <dd>梯宽 {block.stairWidthCm ?? '-'} cm · 转角净宽 {block.stairTurnWidthCm ?? '-'} cm</dd>
            <dt>拆装可能性</dt>
            <dd>
              <span className={`badge ${block.disassemblable ? 'green' : 'red'}`}>
                {block.disassemblable ? '可拆装' : '不可拆装'}
              </span>
              {block.disassemblyNote && <span className="muted" style={{ marginLeft: 6 }}>{block.disassemblyNote}</span>}
            </dd>
            <dt>现场人工加价</dt><dd><Money v={block.laborSurcharge} /></dd>
            {block.siteNote && <><dt>现场备注</dt><dd>{block.siteNote}</dd></>}
          </dl>
          {delivery && (
            <div className="hint" style={{ marginTop: 8 }}>
              配送任务：<Badge map={DELIVERY_STATUS} value={delivery.status} />
              {delivery.failReason !== 'NONE' && ` · ${FAIL_REASON[delivery.failReason] || delivery.failReason}`}
            </div>
          )}
        </div>

        <div className="card">
          <h3>买家方案与费用影响</h3>
          {!block.buyerOption ? (
            <Empty text="勘测已登记，等待买家在四种方案中选择" />
          ) : (
            <dl className="kv">
              <dt>当前方案</dt><dd>{BLOCK_OPTION[block.buyerOption]}</dd>
              <dt>方案附加费</dt>
              <dd>
                <Money v={block.optionFee} />
                <span className="muted" style={{ marginLeft: 6 }}>（在原配送费 <Money v={order?.deliveryFee} /> 之外）</span>
              </dd>
              {block.buyerOption === 'CHANGE_ADDRESS' && (
                <>
                  <dt>改送地址</dt>
                  <dd>{block.newAddress} · {block.newFloor} 层 · {block.newElevator === 'ELEVATOR' ? '有电梯' : '无电梯'}</dd>
                </>
              )}
              {Number(block.buyerBorneOnReturn) > 0 && (
                <>
                  <dt>退货扣款</dt>
                  <dd className="money-out">
                    买家承担已发生吊装费 <Money v={block.buyerBorneOnReturn} />（买家环境限制导致吊装失败）
                  </dd>
                </>
              )}
            </dl>
          )}
          {block.optionHistory?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <b className="hint">选择记录</b>
              <ul className="timeline">
                {block.optionHistory.map((h: any, i: number) => (
                  <li key={i}>
                    <span className={`badge blue`}>{BLOCK_OPTION[h.option]}</span>
                                    <b style={{ margin: '0 6px' }}>{h.byName}</b>
                    <span className="muted">{new Date(h.at).toLocaleString()}</span>
                    <div className="hint">附加费 <Money v={h.fee} />{h.note ? ` · ${h.note}` : ''}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {(block.buyerOption === 'HOIST' || block.hoistStatus !== 'NONE') && (
          <div className="card">
            <h3>
              吊装专项信息
              <span style={{ marginLeft: 8 }}><Badge map={HOIST_STATUS} value={block.hoistStatus} /></span>
              {block.hoistFailCause && (
                <span style={{ marginLeft: 8 }}><Badge map={HOIST_FAIL_CAUSE} value={block.hoistFailCause} /></span>
              )}
            </h3>
            {!block.hoistCompany ? (
              <Empty text="买家选择吊装后，由配送登记吊装公司、物业许可、天气与保险" />
            ) : (
              <dl className="kv">
                <dt>吊装公司</dt><dd>{block.hoistCompany}</dd>
                <dt>物业许可</dt>
                <dd>
                  <span className={`badge ${block.propertyPermit ? 'green' : 'red'}`}>{block.propertyPermit ? '已许可' : '未许可'}</span>
                  {block.propertyPermitNote && <span className="muted" style={{ marginLeft: 6 }}>{block.propertyPermitNote}</span>}
                </dd>
                <dt>天气</dt><dd>{block.weather}</dd>
                <dt>保险确认</dt>
                <dd>
                  <span className={`badge ${block.insuranceConfirmed ? 'green' : 'red'}`}>{block.insuranceConfirmed ? '已确认' : '未确认'}</span>
                  {block.insurancePolicy && <span className="muted" style={{ marginLeft: 6 }}>保单 {block.insurancePolicy}</span>}
                </dd>
                <dt>吊装报价</dt><dd><Money v={block.hoistQuote} /></dd>
                {block.hoistStatus === 'FAILED' && (
                  <>
                    <dt>失败说明</dt><dd>{block.hoistFailNote || '-'}</dd>
                    <dt>第三方追偿</dt>
                    <dd>{Number(block.thirdPartyClaimAmount) > 0 ? <Money v={block.thirdPartyClaimAmount} className="money-in" /> : '—'}</dd>
                  </>
                )}
              </dl>
            )}
          </div>
        )}

        <div className="card">
          <h3>退货回库与二次上架</h3>
          {block.buyerOption !== 'RETURN' ? (
            <Empty text="买家未选择退货；商品无需回库，不产生二次上架" />
          ) : (
            <dl className="kv">
              <dt>回库状态</dt><dd><Badge map={BLOCK_STATUS} value={block.status} /></dd>
              <dt>回库库位</dt><dd>{block.warehouseSlot || '尚未回仓'}</dd>
              <dt>二次上架决策</dt><dd>{RELIST_DECISION[block.relistDecision]}</dd>
              {block.relistReason && <><dt>决策说明</dt><dd>{block.relistReason}</dd></>}
              {block.relistedAt && <><dt>上架时间</dt><dd>{new Date(block.relistedAt).toLocaleString()}</dd></>}
            </dl>
          )}
          <div className="hint" style={{ marginTop: 8 }}>
            卖家结算：方案送达则按成交正常结算（附加费归配送/平台，不扣卖家）；退货则卖家应得为 ¥0，商品回库后决定是否二次上架。
          </div>
        </div>
      </div>

      {showOption && (
        <OptionModal
          block={block}
          onClose={() => setShowOption(false)}
          onDone={async (body) => {
            const ok = await act('option', body, '方案已提交，协同工单已同步');
            if (ok) setShowOption(false);
          }}
        />
      )}
      {showHoist && (
        <ArrangeHoistModal
          block={block}
          onClose={() => setShowHoist(false)}
          onDone={async (body) => {
            const ok = await act('arrange-hoist', body, '吊装已安排（许可/天气/保险已记录）');
            if (ok) setShowHoist(false);
          }}
        />
      )}
      {showResult && (
        <HoistFailModal
          block={block}
          onClose={() => setShowResult(false)}
          onDone={async (body) => {
            const ok = await act('hoist-result', body, '吊装失败已归因，等待买家重新选择方案');
            if (ok) setShowResult(false);
          }}
        />
      )}
      {showReturn && (
        <ReturnModal
          onClose={() => setShowReturn(false)}
          onDone={async (body) => {
            const ok = await act('warehouse-return', body, '退货商品已回仓，等待二次上架决策');
            if (ok) setShowReturn(false);
          }}
        />
      )}
      {showRelist && (
        <RelistModal
          block={block}
          onClose={() => setShowRelist(false)}
          onDone={async (body) => {
            const ok = await act(
              'relist-decision',
              body,
              body.decision === 'RELIST' ? '已二次上架（通道尺寸已写入商品提示）' : '已确认不再上架，商品下架',
            );
            if (ok) setShowRelist(false);
          }}
        />
      )}
    </div>
  );
}

function OptionModal({ block, onClose, onDone }: { block: any; onClose: () => void; onDone: (b: any) => void }) {
  const me = getUser()!;
  const isStaff = ['CS', 'OPS', 'ADMIN'].includes(me.role);
  const [option, setOption] = useState(block.buyerOption || 'DISASSEMBLY');
  const [note, setNote] = useState('');
  const [feeOverride, setFeeOverride] = useState<number | ''>('');
  const [newAddress, setNewAddress] = useState(block.newAddress || '');
  const [newFloor, setNewFloor] = useState<number>(block.newFloor || 1);
  const [newElevator, setNewElevator] = useState(block.newElevator || 'ELEVATOR');

  const addrFee = changeAddressFee(newFloor, newElevator);

  const submit = () => {
    if (option === 'CHANGE_ADDRESS' && !newAddress.trim()) {
      return toast('请填写新收货地址', true);
    }
    const body: any = { option, note };
    if (option === 'CHANGE_ADDRESS') {
      body.newAddress = newAddress;
      body.newFloor = Number(newFloor);
      body.newElevator = newElevator;
      if (isStaff && feeOverride !== '') body.fee = Number(feeOverride);
    } else if ((option === 'DISASSEMBLY') && isStaff && feeOverride !== '') {
      body.fee = Number(feeOverride);
    }
    onDone(body);
  };

  return (
    <Modal
      wide
      title={`选择配送方案 · ${block.code}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn" onClick={submit}>确认选择</button>
        </>
      }
    >
      <div className="banner warn">
        现场勘测：电梯进深 {block.elevatorDepthCm ?? '-'}cm、楼梯转角 {block.stairTurnWidthCm ?? '-'}cm；
        家具{block.disassemblable ? '可拆装' : '不可拆装'}；现场人工加价 <Money v={block.laborSurcharge} />。
      </div>
      <Field label="处理方案">
        <div className="option-list">
          <label className={`option-card ${option === 'DISASSEMBLY' ? 'active' : ''} ${!block.disassemblable ? 'disabled' : ''}`}>
            <input
              type="radio" name="opt"
              disabled={!block.disassemblable}
              checked={option === 'DISASSEMBLY'}
              onChange={() => setOption('DISASSEMBLY')}
            />
            <div>
              <b>① 拆装上楼</b>
              <div className="hint">现场拆解、上楼后复装；附加费 <Money v={block.laborSurcharge} />，成交后正常结算、不产生退货回库</div>
              {!block.disassemblable && <div className="money-out">现场判定不可拆装，不可选择</div>}
            </div>
          </label>
          <label className={`option-card ${option === 'HOIST' ? 'active' : ''}`}>
            <input type="radio" name="opt" checked={option === 'HOIST'} onChange={() => setOption('HOIST')} />
            <div>
              <b>② 吊装上楼</b>
              <div className="hint">
                需登记吊装公司、物业许可、天气与保险；吊装费以报价为准（当前 {block.hoistStatus === 'NONE' ? '待报价' : <Money v={block.hoistQuote} />}）。
                失败将区分买家环境限制 / 配送方案误判 / 第三方责任
              </div>
              {block.hoistStatus === 'FAILED' && (
                <div className="money-out">
                  上次吊装失败（{HOIST_FAIL_CAUSE[block.hoistFailCause]?.label}），再次选择将重新安排
                </div>
              )}
            </div>
          </label>
          <label className={`option-card ${option === 'RETURN' ? 'active' : ''}`}>
            <input type="radio" name="opt" checked={option === 'RETURN'} onChange={() => setOption('RETURN')} />
            <div>
              <b>③ 退货</b>
              <div className="hint">
                买家退款、卖家应得为 ¥0，商品回仓复检后决定是否二次上架；
                {Number(block.buyerBorneOnReturn) > 0
                  ? <span className="money-out">本次退货将扣除已发生吊装费 <Money v={block.buyerBorneOnReturn} /></span>
                  : '无附加费'}
              </div>
            </div>
          </label>
          <label className={`option-card ${option === 'CHANGE_ADDRESS' ? 'active' : ''}`}>
            <input type="radio" name="opt" checked={option === 'CHANGE_ADDRESS'} onChange={() => setOption('CHANGE_ADDRESS')} />
            <div>
              <b>④ 改送其他地址</b>
              <div className="hint">转运到有条件的地址（如亲友家/一楼），预估转运费 <b>¥{addrFee}</b>（基础 ¥100 + 无电梯楼层 ¥15/层）</div>
            </div>
          </label>
        </div>
      </Field>

      {option === 'CHANGE_ADDRESS' && (
        <div className="row2">
          <Field label="新收货地址">
            <input value={newAddress} onChange={(e) => setNewAddress(e.target.value)} placeholder="小区+门牌" />
          </Field>
          <Field label="楼层">
            <input type="number" min={1} value={newFloor} onChange={(e) => setNewFloor(+e.target.value)} />
          </Field>
          <Field label="电梯条件">
            <select value={newElevator} onChange={(e) => setNewElevator(e.target.value)}>
              <option value="ELEVATOR">有电梯</option>
              <option value="NO_ELEVATOR">无电梯</option>
              <option value="WALKUP">楼梯房</option>
            </select>
          </Field>
        </div>
      )}
      {isStaff && (option === 'DISASSEMBLY' || option === 'CHANGE_ADDRESS') && (
        <Field label="附加费人工调整（元，可选；留空用系统计价）">
          <input type="number" min={0} value={feeOverride} onChange={(e) => setFeeOverride(e.target.value === '' ? '' : +e.target.value)} />
        </Field>
      )}
      <Field label="备注（同步到协同工单）">
        <textarea value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

function ArrangeHoistModal({ block, onClose, onDone }: { block: any; onClose: () => void; onDone: (b: any) => void }) {
  const [f, setF] = useState({
    hoistCompany: block.hoistCompany || '',
    propertyPermit: !!block.propertyPermit,
    propertyPermitNote: block.propertyPermitNote || '',
    weather: '',
    insuranceConfirmed: !!block.insuranceConfirmed,
    insurancePolicy: block.insurancePolicy || '',
    hoistQuote: block.hoistQuote && block.hoistQuote !== '0.00' ? Number(block.hoistQuote) : 600,
  });
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));

  return (
    <Modal
      wide
      title={`安排吊装 · ${block.code}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn" onClick={() => onDone({ ...f, hoistQuote: Number(f.hoistQuote) })}>确认安排</button>
        </>
      }
    >
      <div className="banner warn">高空作业必须四证齐全：吊装公司、物业许可、适合作业天气、吊装保险。任一不满足系统将拒绝安排。</div>
      <div className="row2">
        <Field label="吊装公司">
          <input value={f.hoistCompany} onChange={(e) => set('hoistCompany', e.target.value)} placeholder="如 顺达高空吊装有限公司" />
        </Field>
        <Field label="吊装报价（元，计入买家附加费）">
          <input type="number" min={0} value={f.hoistQuote} onChange={(e) => set('hoistQuote', +e.target.value)} />
        </Field>
        <Field label="作业当日天气">
          <input value={f.weather} onChange={(e) => set('weather', e.target.value)} placeholder="如 晴，东北风 2 级（大风/雷雨将被拦截）" />
        </Field>
        <Field label="物业许可凭证/说明">
          <input value={f.propertyPermitNote} onChange={(e) => set('propertyPermitNote', e.target.value)} placeholder="如 物业已开具许可单编号" />
        </Field>
        <Field label="保险单号">
          <input value={f.insurancePolicy} onChange={(e) => set('insurancePolicy', e.target.value)} placeholder="如 POLICY-XX-001" />
        </Field>
      </div>
      <label className="checkline" style={{ marginRight: 24 }}>
        <input type="checkbox" checked={f.propertyPermit} onChange={(e) => set('propertyPermit', e.target.checked)} />
        已取得物业吊装许可
      </label>
      <label className="checkline">
        <input type="checkbox" checked={f.insuranceConfirmed} onChange={(e) => set('insuranceConfirmed', e.target.checked)} />
        吊装保险已确认
      </label>
    </Modal>
  );
}

function HoistFailModal({ block, onClose, onDone }: { block: any; onClose: () => void; onDone: (b: any) => void }) {
  const [cause, setCause] = useState('THIRD_PARTY');
  const [failNote, setFailNote] = useState('');
  const [claim, setClaim] = useState<number>(Number(block.hoistQuote || 0));

  return (
    <Modal
      title={`吊装失败归因 · ${block.code}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button
            className="btn danger"
            onClick={() =>
              onDone({
                success: false,
                failCause: cause,
                failNote,
                thirdPartyClaimAmount: cause === 'THIRD_PARTY' ? Number(claim) : undefined,
              })
            }
          >
            确认失败并归因
          </button>
        </>
      }
    >
      <Field label="失败责任归因（决定费用由谁承担）">
        <select value={cause} onChange={(e) => setCause(e.target.value)}>
          <option value="BUYER_ENVIRONMENT">买家环境限制（外立面无吊点/物业临时禁吊等，吊装费买家承担）</option>
          <option value="PLAN_MISJUDGE">配送方案误判（平台勘测/调度误判，吊装费平台承担）</option>
          <option value="THIRD_PARTY">第三方责任（吊装公司操作不当/设备故障，平台垫付后追偿）</option>
        </select>
      </Field>
      {cause === 'THIRD_PARTY' && (
        <Field label={`向「${block.hoistCompany || '吊装公司'}」追偿金额（元）`}>
          <input type="number" min={0} value={claim} onChange={(e) => setClaim(+e.target.value)} />
        </Field>
      )}
      <Field label="现场情况说明（取证记录）">
        <textarea style={{ minHeight: 90 }} value={failNote} onChange={(e) => setFailNote(e.target.value)} />
      </Field>
      <div className="banner info">
        归因后买家可重新选择方案；第三方责任的吊装费不向买家收取，按追偿金额计入结算「第三方追偿」。
      </div>
    </Modal>
  );
}

function ReturnModal({ onClose, onDone }: { onClose: () => void; onDone: (b: any) => void }) {
  const [slot, setSlot] = useState('');
  const [note, setNote] = useState('');
  return (
    <Modal
      title="退货商品回库登记"
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn" disabled={!slot.trim()} onClick={() => onDone({ warehouseSlot: slot, note })}>确认回仓</button>
        </>
      }
    >
      <Field label="回库库位（如 A-05-01）">
        <input value={slot} onChange={(e) => setSlot(e.target.value)} />
      </Field>
      <Field label="复检情况（外观/功能/包装）">
        <textarea value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

function RelistModal({ block, onClose, onDone }: { block: any; onClose: () => void; onDone: (b: any) => void }) {
  const [decision, setDecision] = useState<'RELIST' | 'NO_RELIST'>('RELIST');
  const [reason, setReason] = useState('');
  const [newPrice, setNewPrice] = useState<number | ''>('');
  const [radius, setRadius] = useState<number | ''>('');
  return (
    <Modal
      wide
      title={`二次上架决策 · 库位 ${block.warehouseSlot}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn gray" onClick={onClose}>取消</button>
          <button
            className="btn"
            onClick={() =>
              onDone({
                decision,
                reason,
                newPrice: newPrice === '' ? undefined : Number(newPrice),
                deliveryRadiusKm: radius === '' ? undefined : Number(radius),
              })
            }
          >
            确认决策
          </button>
        </>
      }
    >
      <Field label="是否二次上架（决定是否产生二次上架）">
        <select value={decision} onChange={(e) => setDecision(e.target.value as any)}>
          <option value="RELIST">复检合格 → 二次上架（商品描述自动补充通道尺寸提示）</option>
          <option value="NO_RELIST">不再销售 → 商品下架终止</option>
        </select>
      </Field>
      {decision === 'RELIST' && (
        <div className="row2">
          <Field label="调整挂牌价（元，可选）">
            <input type="number" min={0} value={newPrice} onChange={(e) => setNewPrice(e.target.value === '' ? '' : +e.target.value)} />
          </Field>
          <Field label="配送范围（公里，0=仅同城自提；可选）">
            <input type="number" min={0} value={radius} onChange={(e) => setRadius(e.target.value === '' ? '' : +e.target.value)} />
          </Field>
        </div>
      )}
      <Field label="决策说明">
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}
