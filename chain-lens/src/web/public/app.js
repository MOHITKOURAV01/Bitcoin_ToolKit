/**
 * Chain Lens web UI.
 *
 * Transaction mode posts a fixture to /api/analyze and narrates the report.
 * Block mode uploads blk/rev/xor as raw bytes and pages through the results.
 */
document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);
    const fmt = (n) => Number(n || 0).toLocaleString('en-US');
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const shorten = (t, h = 10, tl = 8) =>
        !t ? '—' : t.length <= h + tl + 3 ? t : `${t.slice(0, h)}…${t.slice(-tl)}`;

    /** Friendly names for the script types the analyzer reports. */
    const SCRIPT_LABELS = {
        p2pkh: 'Legacy (P2PKH)',
        p2sh: 'Script hash (P2SH)',
        p2wpkh: 'SegWit (P2WPKH)',
        p2wsh: 'SegWit script (P2WSH)',
        p2tr: 'Taproot (P2TR)',
        p2tr_keypath: 'Taproot key path',
        p2tr_scriptpath: 'Taproot script path',
        'p2sh-p2wpkh': 'Wrapped SegWit',
        'p2sh-p2wsh': 'Wrapped SegWit script',
        op_return: 'Data (OP_RETURN)',
        unknown: 'Unrecognised',
    };

    const SATS_PER_BTC = 100000000;

    /** Display unit, toggled in the header. Amounts are always sats internally. */
    let unit = 'sats';
    let lastTx = null;

    /** Raw hex of the transaction currently on screen, for the byte inspector. */
    let currentRawTx = null;

    const amount = (sats) => (unit === 'btc' ? (Number(sats) / SATS_PER_BTC).toFixed(8) : fmt(sats));
    const unitLabel = () => (unit === 'btc' ? 'BTC' : 'sats');

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /** Sets --i on each child so CSS can stagger their entrance animations. */
    function stagger(container, selector = ':scope > *') {
        if (!container) return;
        container.querySelectorAll(selector).forEach((node, i) => node.style.setProperty('--i', i));
    }

    /**
     * Counts an element up to its final value. The final value is written first
     * so the correct figure shows even if animation frames never run.
     */
    function countUp(node, to, format = fmt, duration = 620) {
        node.textContent = format(to);
        if (prefersReducedMotion) return;

        const start = performance.now();
        const step = (now) => {
            const t = Math.min(1, (now - start) / duration);
            const eased = 1 - Math.pow(1 - t, 3);
            node.textContent = format(to * eased);
            if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    /** Green-to-red fee-rate banding, as block explorers show it. */
    function feeBand(rate) {
        if (rate <= 1) return { color: 'var(--rate-1)', name: 'minimum', note: 'the cheapest rate the network will relay' };
        if (rate <= 5) return { color: 'var(--rate-2)', name: 'low', note: 'fine when there is no hurry' };
        if (rate <= 15) return { color: 'var(--rate-3)', name: 'normal', note: 'a typical rate in ordinary conditions' };
        if (rate <= 40) return { color: 'var(--rate-4)', name: 'priority', note: 'buys a place in the next block or two' };
        if (rate <= 100) return { color: 'var(--rate-5)', name: 'high', note: 'well above what is usually needed' };
        return { color: 'var(--rate-6)', name: 'very high', note: 'far more than the network normally requires' };
    }

    /** Maps a fee rate onto the gauge's non-linear 0-100% scale. */
    function ratePosition(rate) {
        const stops = [0, 1, 5, 15, 40, 100, 300];
        for (let i = 1; i < stops.length; i += 1) {
            if (rate <= stops[i]) {
                const span = stops[i] - stops[i - 1];
                const within = span === 0 ? 0 : (rate - stops[i - 1]) / span;
                return ((i - 1 + within) / (stops.length - 1)) * 100;
            }
        }
        return 100;
    }

    const TYPE_COLORS = {
        p2pkh: '#e0245e',
        p2sh: '#f2620f',
        'p2sh-p2wpkh': '#f7931a',
        'p2sh-p2wsh': '#f0a500',
        p2wpkh: '#2bd576',
        p2wsh: '#12b886',
        p2tr: '#4f8cff',
        p2tr_keypath: '#4f8cff',
        p2tr_scriptpath: '#6ea6ff',
        op_return: '#8a94a8',
        unknown: '#6c7a94',
    };
    const typeColor = (type) => TYPE_COLORS[type] || TYPE_COLORS.unknown;

    const WARNING_INFO = {
        HIGH_FEE: { level: 'danger', icon: '🔥', title: 'Unusually high fee', text: 'This transaction pays far more than typical. Worth a second look.' },
        DUST_OUTPUT: { level: 'warn', icon: '🧹', title: 'Dust output', text: 'An output is under 546 sats — it would cost more to spend than it is worth.' },
        UNKNOWN_OUTPUT_SCRIPT: { level: 'warn', icon: '❓', title: 'Unrecognised output script', text: 'An output does not match any standard address type, so no address can be shown.' },
        RBF_SIGNALING: { level: 'note', icon: '🔁', title: 'Replaceable (RBF)', text: 'The sender can replace this with a higher-fee version until it confirms.' },
    };

    // ── Tabs ────────────────────────────────────────────────────────────────
    document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
            document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
            btn.classList.add('active');
            $(`${btn.dataset.tab}-tab`).classList.add('active');
        });
    });

    // ══ Transaction mode ════════════════════════════════════════════════════
    const describeTx = (name) => {
        const rules = [
            [/legacy_p2pkh/, 'A pre-SegWit payment using classic "1…" addresses.'],
            [/p2sh_p2wsh/, 'A SegWit script wrapped inside a legacy P2SH address.'],
            [/multi_input_segwit/, 'Several SegWit coins combined into one payment.'],
            [/multi_input_legacy/, 'Several legacy coins combined into one payment.'],
            [/segwit_p2wpkh_p2tr/, 'Mixes a SegWit input with a Taproot output.'],
            [/segwit_nested/, 'Nested SegWit with an empty witness item — a parsing edge case.'],
            [/op_return_empty/, 'A bare OP_RETURN carrying no data at all.'],
            [/op_return/, 'Stamps arbitrary data onto the chain via OP_RETURN.'],
            [/dust/, 'Creates an output too small to be worth spending later.'],
            [/high_fee/, 'Pays a fee high enough to trigger a warning.'],
            [/locktime_endianness/, 'Checks that the locktime field is read in the right byte order.'],
            [/prevouts_unordered/, 'The spent coins are supplied out of order and must be matched by outpoint.'],
            [/varint_vin/, 'Uses a multi-byte length prefix for the input count.'],
            [/varint_vout/, 'Uses a multi-byte length prefix for the output count.'],
            [/varint_witness/, 'Uses a multi-byte length prefix inside the witness.'],
            [/varint_scriptsig/, 'Uses a multi-byte length prefix for the scriptSig.'],
            [/scriptpubkey_len/, 'Has an unusually long output script.'],
            [/witness_item_len/, 'Carries a very large witness item.'],
            [/unknown_witness_program/, 'Uses a witness version that does not exist yet.'],
            [/unknown_output_script/, 'Pays to a script that matches no standard type.'],
            [/almost_p2pkh/, 'Looks like a legacy script but has the wrong push length.'],
        ];
        const hit = rules.find(([re]) => re.test(name));
        return hit ? hit[1] : 'A Bitcoin transaction to decode and explain.';
    };

    async function loadTxFixtures() {
        try {
            const data = await (await fetch('/api/fixtures')).json();
            if (!data.ok) throw new Error();
            $('tx-picker').innerHTML = '<option value="">— choose a sample —</option>';
            data.fixtures.forEach((name) => {
                const o = document.createElement('option');
                o.value = name;
                o.textContent = name.replace(/_/g, ' ');
                $('tx-picker').appendChild(o);
            });
        } catch (e) {
            $('tx-picker').innerHTML = '<option value="">No samples available — paste JSON below</option>';
        }
    }

    $('tx-picker').addEventListener('change', async () => {
        const name = $('tx-picker').value;
        if (!name) return;
        try {
            const fixture = await (await fetch(`/api/fixtures/${encodeURIComponent(name)}`)).json();
            $('tx-json').value = JSON.stringify(fixture, null, 2);
            $('tx-description').textContent = describeTx(name);
            hide($('tx-error'));
        } catch (e) {
            showError($('tx-error'), 'LOAD_FAILED', 'Could not load that sample.');
        }
    });

    $('tx-upload').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => { $('tx-json').value = ev.target.result; hide($('tx-error')); };
        reader.readAsText(file);
    });

    $('analyze-tx').addEventListener('click', async () => {
        const raw = $('tx-json').value.trim();
        if (!raw) return showError($('tx-error'), 'NO_INPUT', 'Load a sample or paste a fixture first.');

        let fixture;
        try {
            fixture = JSON.parse(raw);
        } catch (err) {
            return showError($('tx-error'), 'INVALID_JSON', `That is not valid JSON — ${err.message}`);
        }

        $('analyze-tx').disabled = true;
        $('analyze-tx').textContent = 'Analyzing…';
        hide($('tx-error'));

        try {
            const report = await (await fetch('/api/analyze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fixture),
            })).json();

            if (!report.ok) {
                showError($('tx-error'), report.error.code, report.error.message);
                $('tx-results').classList.add('hidden');
                $('tx-empty').classList.remove('hidden');
            } else {
                currentRawTx = fixture.raw_tx;
                renderTx(report);
            }
        } catch (err) {
            showError($('tx-error'), 'API_UNREACHABLE', 'Could not reach the analyzer API.');
        } finally {
            $('analyze-tx').disabled = false;
            $('analyze-tx').textContent = 'Analyze';
        }
    });

    function renderTx(r, scroll = true) {
        lastTx = r;
        $('tx-empty').classList.add('hidden');
        $('tx-results').classList.remove('hidden');

        // Story
        const payees = r.vout.filter((o) => o.script_type !== 'op_return').length;
        const story = [
            `This transaction spends <b>${r.vin.length} coin${r.vin.length === 1 ? '' : 's'}</b>`,
            r.total_input_sats ? `worth <b>${amount(r.total_input_sats)} ${unitLabel()}</b>` : '',
            `and creates <b>${r.vout.length} new output${r.vout.length === 1 ? '' : 's'}</b>`,
            payees !== r.vout.length ? `(one of which just stores data)` : '',
            `totalling <b>${amount(r.total_output_sats)} ${unitLabel()}</b>.`,
            `The <b>${amount(r.fee_sats)} ${unitLabel()}</b> left over is the miner's fee — about <b>${Number(r.fee_rate_sat_vb).toFixed(2)} sats per virtual byte</b>.`,
            r.segwit
                ? 'It is a <b>SegWit</b> transaction, so its signatures sit in a discounted section and it pays for less block space.'
                : 'It is a <b>legacy</b> (pre-SegWit) transaction, so every byte is charged at full price.',
        ].filter(Boolean);
        $('tx-story').innerHTML = story.join(' ');

        const count = (v) => fmt(Math.round(v));
        const money = (v) => (unit === 'btc' ? (v / SATS_PER_BTC).toFixed(8) : fmt(Math.round(v)));

        countUp($('tx-vin-count'), r.vin.length, count);
        countUp($('tx-in-sats'), r.total_input_sats, money);
        countUp($('tx-vout-count'), r.vout.length, count);
        countUp($('tx-out-sats'), r.total_output_sats, money);
        countUp($('tx-fee'), r.fee_sats, money);
        countUp($('tx-fee-rate'), Number(r.fee_rate_sat_vb), (v) => v.toFixed(2));
        countUp($('tx-vbytes'), r.vbytes, count);
        countUp($('tx-weight'), r.weight, count);
        $('flow-size').textContent = `${fmt(r.vbytes)} vB`;
        $('vin-badge').textContent = fmt(r.vin.length);
        $('vout-badge').textContent = fmt(r.vout.length);

        renderWarnings($('tx-warnings'), r.warnings);

        $('vin-list').innerHTML = r.vin.map((input, i) => `
            <div class="item">
                <div class="item-top">
                    <span class="item-addr" title="${esc(input.address || input.txid)}">${esc(input.address ? shorten(input.address, 12, 8) : `${shorten(input.txid)}:${input.vout}`)}</span>
                    <span class="item-type">${esc(SCRIPT_LABELS[input.script_type] || input.script_type)}</span>
                </div>
                <div class="item-bottom">
                    <span class="item-amount">${input.prevout ? esc(amount(input.prevout.value_sats)) : '?'} <span>${unitLabel()}</span></span>
                    <span class="item-note">input #${i}</span>
                </div>
            </div>`).join('');

        $('vout-list').innerHTML = r.vout.map((out) => `
            <div class="item ${out.script_type === 'op_return' ? 'is-data' : 'is-payment'}">
                <div class="item-top">
                    <span class="item-addr" title="${esc(out.address || out.script_pubkey_hex)}">${esc(out.address ? shorten(out.address, 12, 8) : shorten(out.script_pubkey_hex, 14, 6))}</span>
                    <span class="item-type">${esc(SCRIPT_LABELS[out.script_type] || out.script_type)}</span>
                </div>
                <div class="item-bottom">
                    <span class="item-amount">${esc(amount(out.value_sats))} <span>${unitLabel()}</span></span>
                    <span class="item-note">output #${out.n}</span>
                </div>
                ${out.op_return_data_utf8 ? `<div class="item-data">“${esc(out.op_return_data_utf8)}”</div>` : ''}
            </div>`).join('');

        // Value split bar
        const total = r.total_input_sats || r.total_output_sats + r.fee_sats;
        const pct = (v) => (total > 0 ? (v / total) * 100 : 0);
        $('tx-balance-bar').innerHTML = `
            <div class="bar-seg bar-pay" style="width:${pct(r.total_output_sats)}%" title="to outputs">${pct(r.total_output_sats) > 14 ? 'to recipients' : ''}</div>
            <div class="bar-seg bar-fee" style="width:${pct(r.fee_sats)}%" title="miner fee">${pct(r.fee_sats) > 14 ? 'fee' : ''}</div>`;
        $('tx-balance-check').textContent =
            `${amount(r.total_input_sats)} in  −  ${amount(r.total_output_sats)} out  =  ${amount(r.fee_sats)} ${unitLabel()} fee`;

        stagger($('vin-list'));
        stagger($('vout-list'));
        stagger($('tx-balance-bar'));

        renderGauge(r);
        renderShape(r);
        renderSankey(r);
        renderSegwit(r);
        renderRules(r);
        renderHexMap(currentRawTx);
        renderTech(r);

        if (scroll) $('tx-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function renderSegwit(r) {
        const s = r.segwit_savings;
        if (!s) {
            $('segwit-body').innerHTML = `
                <div class="note-box">This is a legacy transaction — there is no witness data, so there is no discount
                    to show. Every one of its ${fmt(r.size_bytes)} bytes counts at full weight.</div>`;
            return;
        }
        const maxWeight = Math.max(s.weight_actual, s.weight_if_legacy) || 1;
        $('segwit-body').innerHTML = `
            <div class="weight-compare">
                <div class="weight-row">
                    <span class="weight-label">As built (SegWit)</span>
                    <div class="weight-track"><div class="weight-fill actual" style="width:${(s.weight_actual / maxWeight) * 100}%"></div></div>
                    <span class="weight-val">${fmt(s.weight_actual)} WU</span>
                </div>
                <div class="weight-row">
                    <span class="weight-label">If it were legacy</span>
                    <div class="weight-track"><div class="weight-fill legacy" style="width:${(s.weight_if_legacy / maxWeight) * 100}%"></div></div>
                    <span class="weight-val">${fmt(s.weight_if_legacy)} WU</span>
                </div>
            </div>
            <div class="savings">Saves <b>${s.savings_pct}%</b> of the block space it would otherwise need.</div>
            <div class="math-row"><span>Witness bytes (discounted 4×)</span><b>${fmt(s.witness_bytes)}</b></div>
            <div class="math-row"><span>Non-witness bytes (full price)</span><b>${fmt(s.non_witness_bytes)}</b></div>
            <div class="math-row"><span>Total size on the wire</span><b>${fmt(s.total_bytes)} bytes</b></div>`;
        $('segwit-body').querySelectorAll('.weight-fill').forEach((node, i) => node.style.setProperty('--i', i));
    }

    function renderRules(r) {
        $('tx-rbf-badge').textContent = r.rbf_signaling ? 'on' : 'off';
        $('tx-rbf-badge').className = `badge ${r.rbf_signaling ? 'on' : ''}`;
        $('tx-rbf-text').textContent = r.rbf_signaling
            ? 'At least one input has a sequence number below 0xfffffffe, which tells the network the sender may replace this transaction with a higher-fee version. Do not treat it as final until it confirms.'
            : 'No input signals replaceability, so the sender cannot simply bump the fee on this transaction.';

        const lt = r.locktime_type;
        $('tx-lock-badge').textContent = lt === 'none' ? 'none' : lt.replace('_', ' ');
        $('tx-lock-badge').className = `badge ${lt === 'none' ? '' : 'warn'}`;
        $('tx-lock-text').textContent = lt === 'none'
            ? 'No absolute timelock — this can be mined immediately.'
            : lt === 'block_height'
                ? `Cannot be mined until block ${fmt(r.locktime_value)} exists.`
                : `Cannot be mined until the clock passes ${new Date(r.locktime_value * 1000).toUTCString()}.`;

        const locked = r.vin.filter((v) => v.relative_timelock && v.relative_timelock.enabled);
        $('tx-rel-badge').textContent = locked.length ? `${locked.length} input${locked.length === 1 ? '' : 's'}` : 'none';
        $('tx-rel-badge').className = `badge ${locked.length ? 'warn' : ''}`;
        $('tx-rel-text').textContent = locked.length
            ? locked.map((v) => v.relative_timelock.type === 'blocks'
                ? `one input must be ${v.relative_timelock.value} block(s) old`
                : `one input must be ${v.relative_timelock.value} second(s) old`).join('; ')
                + '. Relative timelocks force a coin to age before it can be respent.'
            : 'No input requires its coin to age before being spent.';
    }

    function renderTech(r) {
        $('tech-details').innerHTML = `
            <div class="kv"><span>txid</span><code>${esc(r.txid)}</code></div>
            <div class="kv"><span>wtxid</span><code>${esc(r.wtxid ?? 'null (legacy transaction)')}</code></div>
            <div class="kv"><span>version</span><code>${esc(r.version)}</code></div>
            <div class="kv"><span>locktime</span><code>${esc(r.locktime)} (${esc(r.locktime_type)})</code></div>
            <div class="kv"><span>size / weight / vbytes</span><code>${fmt(r.size_bytes)} B · ${fmt(r.weight)} WU · ${fmt(r.vbytes)} vB</code></div>
            <h4 class="tech-head">Inputs</h4>
            ${r.vin.map((v, i) => `
                <div class="tech-block">
                    <div class="kv"><span>#${i} outpoint</span><code>${esc(v.txid)}:${esc(v.vout)}</code></div>
                    <div class="kv"><span>sequence</span><code>${esc(v.sequence)}</code></div>
                    <div class="kv"><span>script_sig_asm</span><code>${esc(v.script_asm || '""')}</code></div>
                    ${v.witness_script_asm ? `<div class="kv"><span>witness_script_asm</span><code>${esc(v.witness_script_asm)}</code></div>` : ''}
                    <div class="kv"><span>witness (${v.witness.length})</span><code>${v.witness.length ? v.witness.map((w) => esc(shorten(w, 20, 10)) || '""').join('<br>') : '[]'}</code></div>
                </div>`).join('')}
            <h4 class="tech-head">Outputs</h4>
            ${r.vout.map((o) => `
                <div class="tech-block">
                    <div class="kv"><span>#${o.n} script_asm</span><code>${esc(o.script_asm)}</code></div>
                    <div class="kv"><span>script_pubkey</span><code>${esc(shorten(o.script_pubkey_hex, 40, 12))}</code></div>
                    ${o.op_return_data_hex !== undefined ? `<div class="kv"><span>op_return data</span><code>${esc(o.op_return_data_hex || '(empty)')} · ${esc(o.op_return_protocol)}</code></div>` : ''}
                </div>`).join('')}`;
    }

    $('toggle-tech').addEventListener('click', () => {
        const panel = $('tech-details');
        const hidden = panel.classList.toggle('hidden');
        $('toggle-tech').textContent = hidden ? 'Show' : 'Hide';
    });

    // ══ Block mode ══════════════════════════════════════════════════════════
    let uploadId = null;

    ['blk', 'rev', 'xor'].forEach((kind) => {
        $(`${kind}-file`).addEventListener('change', (e) => {
            const file = e.target.files[0];
            $(`${kind}-state`).textContent = file ? `${file.name} (${(file.size / 1048576).toFixed(1)} MB)` : 'no file chosen';
        });
    });

    $('analyze-block').addEventListener('click', async () => {
        const blk = $('blk-file').files[0];
        const rev = $('rev-file').files[0];
        const xor = $('xor-file').files[0];

        if (!blk || !rev) {
            return showError($('block-error'), 'MISSING_FILES', 'Choose both a blk*.dat and a rev*.dat file.');
        }

        hide($('block-error'));
        $('analyze-block').disabled = true;
        $('block-progress').classList.remove('hidden');

        try {
            uploadId = null;
            const files = [['blk', blk], ['rev', rev]].concat(xor ? [['xor', xor]] : []);

            for (let i = 0; i < files.length; i++) {
                const [kind, file] = files[i];
                setProgress((i / (files.length + 1)) * 100, `Uploading ${kind} (${(file.size / 1048576).toFixed(1)} MB)…`);
                const headers = { 'Content-Type': 'application/octet-stream' };
                if (uploadId) headers['X-Upload-Id'] = uploadId;
                const res = await fetch(`/api/upload/${kind}`, { method: 'POST', headers, body: file });
                const data = await res.json();
                if (!data.ok) throw new Error(data.error.message);
                uploadId = data.upload_id;
            }

            setProgress(85, 'Decoding blocks — this can take a moment for a full 127 MB file…');
            const res = await fetch('/api/analyze/block', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ upload_id: uploadId }),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(`${data.error.code}: ${data.error.message}`);

            setProgress(100, 'Done');
            renderBlocks(data);
        } catch (err) {
            showError($('block-error'), 'BLOCK_ANALYSIS_FAILED', err.message);
            $('block-results').classList.add('hidden');
        } finally {
            $('analyze-block').disabled = false;
            setTimeout(() => $('block-progress').classList.add('hidden'), 800);
        }
    });

    function setProgress(pct, text) {
        $('block-progress-bar').style.width = `${pct}%`;
        $('block-progress-text').textContent = text;
    }

    // Delegated once: renderBlocks replaces the list's contents on every run.
    $('block-list').addEventListener('click', onLoadTransactions);

    function renderBlocks(data) {
        $('block-results').classList.remove('hidden');

        const totalTx = data.blocks.reduce((s, b) => s + b.tx_count, 0);
        const totalFees = data.blocks.reduce((s, b) => s + b.block_stats.total_fees_sats, 0);
        const allValid = data.blocks.every((b) => b.block_header.merkle_root_valid);

        $('block-story').innerHTML = `
            This file contains <b>${fmt(data.block_count)} block${data.block_count === 1 ? '' : 's'}</b> holding
            <b>${fmt(totalTx)} transactions</b> between them. Miners collected
            <b>${fmt(totalFees)} sats</b> in fees across all of them.
            ${allValid
                ? 'Every block\'s <b>merkle root</b> was recomputed from its transactions and matched the header — proof that nothing in these blocks has been altered.'
                : '<b>Warning:</b> at least one block\'s merkle root did not match its header.'}`;

        $('block-stats').innerHTML = `
            <div class="stat"><span class="stat-label">Blocks</span><span class="stat-value">${fmt(data.block_count)}</span><span class="stat-sub">in this file</span></div>
            <div class="stat"><span class="stat-label">Transactions</span><span class="stat-value">${fmt(totalTx)}</span><span class="stat-sub">across all blocks</span></div>
            <div class="stat"><span class="stat-label">Total fees</span><span class="stat-value accent-warn">${fmt(totalFees)}</span><span class="stat-sub">sats to miners</span></div>
            <div class="stat"><span class="stat-label">Merkle proofs</span><span class="stat-value">${allValid ? '✓' : '✗'}</span><span class="stat-sub">${allValid ? 'all verified' : 'mismatch found'}</span></div>`;

        $('block-list').innerHTML = data.blocks.map((b) => {
            const h = b.block_header;
            const hash = h.block_hash;
            return `
            <details class="block-item" data-hash="${esc(hash)}">
                <summary>
                    <span class="heat" style="color:${feeBand(b.block_stats.avg_fee_rate_sat_vb).color}; background:${feeBand(b.block_stats.avg_fee_rate_sat_vb).color}"
                        title="average ${b.block_stats.avg_fee_rate_sat_vb} sat/vB — ${feeBand(b.block_stats.avg_fee_rate_sat_vb).name}"></span>
                    <span class="block-height">#${fmt(b.coinbase.bip34_height)}</span>
                    <span class="block-hash">${esc(shorten(hash, 12, 10))}</span>
                    <span class="block-meta">${fmt(b.tx_count)} txs &middot; ${fmt(b.block_stats.total_fees_sats)} sats fees &middot; ${b.block_stats.avg_fee_rate_sat_vb} sat/vB</span>
                    <span class="badge ${h.merkle_root_valid ? 'on' : 'warn'}">${h.merkle_root_valid ? 'verified' : 'invalid'}</span>
                </summary>
                <div class="block-body">
                    <div class="kv"><span>block hash</span><code>${esc(hash)}</code></div>
                    <div class="kv"><span>previous block</span><code>${esc(h.prev_block_hash)}</code></div>
                    <div class="kv"><span>merkle root</span><code>${esc(h.merkle_root)}</code></div>
                    <div class="kv"><span>mined at</span><code>${new Date(h.timestamp * 1000).toUTCString()}</code></div>
                    <div class="kv"><span>coinbase reward</span><code>${fmt(b.coinbase.total_output_sats)} sats (subsidy + fees)</code></div>
                    <div class="kv"><span>total weight</span><code>${fmt(b.block_stats.total_weight)} WU</code></div>
                    <div class="script-summary">${Object.entries(b.block_stats.script_type_summary)
                        .filter(([, n]) => n > 0)
                        .map(([type, n]) => `<span class="chip">${esc(SCRIPT_LABELS[type] || type)}: ${fmt(n)}</span>`).join('')}</div>
                    <div class="tx-page" id="txpage-${esc(hash)}"><button class="btn btn-ghost btn-sm load-txs" data-hash="${esc(hash)}" data-offset="0">Show transactions</button></div>
                </div>
            </details>`;
        }).join('');
        stagger($('block-list'), '.block-item');
        renderBlockAnalytics(data.blocks);

    }

    async function onLoadTransactions(event) {
        const btn = event.target.closest('.load-txs');
        if (!btn) return;

        const hash = btn.dataset.hash;
        const offset = parseInt(btn.dataset.offset, 10) || 0;
        btn.disabled = true;
        btn.textContent = 'Loading…';

        try {
            const res = await fetch(`/api/block/${hash}/transactions?upload_id=${encodeURIComponent(uploadId)}&offset=${offset}&limit=25`);
            const data = await res.json();
            if (!data.ok) throw new Error(data.error.message);

            const container = $(`txpage-${hash}`);
            const rows = data.transactions.map((tx, i) => `
                <div class="tx-row">
                    <span class="tx-index">${fmt(offset + i)}</span>
                    <code class="tx-id">${esc(shorten(tx.txid, 14, 10))}</code>
                    <span class="tx-io">${tx.vin.length} in → ${tx.vout.length} out</span>
                    <span class="tx-fee">${offset + i === 0 ? 'coinbase' : `${fmt(tx.fee_sats)} sats fee`}</span>
                    <span class="tx-size">${fmt(tx.vbytes)} vB</span>
                    <span class="item-type">${esc(tx.segwit ? 'SegWit' : 'legacy')}</span>
                </div>`).join('');

            btn.remove();
            container.insertAdjacentHTML('beforeend', rows);
            container.querySelectorAll('.tx-row').forEach((node, i) => node.style.setProperty('--i', i % 25));

            const nextOffset = offset + data.transactions.length;
            if (nextOffset < data.total) {
                container.insertAdjacentHTML('beforeend',
                    `<button class="btn btn-ghost btn-sm load-txs" data-hash="${esc(hash)}" data-offset="${nextOffset}">Show 25 more (${fmt(data.total - nextOffset)} left)</button>`);
            }
        } catch (err) {
            btn.disabled = false;
            btn.textContent = `Failed — ${err.message}. Retry`;
        }
    }

    // ── Transaction shape ───────────────────────────────────────────────────
    /**
     * Infers what a transaction is *for* from its shape. These are the same
     * clues any chain observer uses, which is exactly why they matter for
     * privacy — see the findings rendered underneath.
     */
    function classifyShape(r) {
        const ins = r.vin.length;
        const spendable = r.vout.filter((o) => o.script_type !== 'op_return');
        const outs = spendable.length;
        const values = spendable.map((o) => o.value_sats);

        if (r.vin.length === 1 && r.vin[0].txid === '0'.repeat(64)) {
            return { name: 'Coinbase', icon: '⛏️', text: 'This is the first transaction in a block. It has no real inputs — it mints the block subsidy and collects every fee paid by the other transactions.' };
        }
        const dataOutputs = r.vout.length - outs;
        if (outs === 0 && dataOutputs > 0) {
            return { name: 'Data stamp', icon: '📌', text: 'Every output of this transaction is an OP_RETURN: it moves no spendable value at all, it only writes a small piece of data into the chain permanently. The whole input value went to the miner as fee.' };
        }

        // Equal-valued outputs across many inputs is the CoinJoin signature.
        if (ins >= 3 && outs >= 3 && new Set(values).size <= Math.ceil(outs / 2)) {
            return { name: 'Possible CoinJoin', icon: '🌀', text: 'Many inputs produce many equal-sized outputs. That is the signature of a collaborative transaction, where several people combine payments so no observer can tell whose coin went where.' };
        }
        if (ins >= 5 && outs === 1) {
            return { name: 'Consolidation', icon: '🧹', text: `${ins} separate coins were swept into a single one. Wallets do this when fees are cheap, because holding many small coins makes every future payment larger and more expensive.` };
        }
        if (ins === 1 && outs >= 5) {
            return { name: 'Batch payment', icon: '📦', text: `One coin was split ${outs} ways. Exchanges and payroll systems batch payouts like this — it is far cheaper than broadcasting ${outs} separate transactions.` };
        }
        if (ins === 1 && outs === 1) {
            return { name: 'Sweep', icon: '➡️', text: 'One coin in, one coin out, no change. The sender emptied an address completely — often a withdrawal or a wallet migration.' };
        }
        if (outs === 2) {
            return { name: 'Payment with change', icon: '💸', text: 'The everyday shape: pay someone, and send the remainder back to yourself as change. One of these two outputs is the payment and one is change — which is which is the question below.' };
        }
        return { name: 'Payment', icon: '💸', text: `${ins} coin${ins === 1 ? '' : 's'} spent into ${outs} output${outs === 1 ? '' : 's'}.` };
    }

    /**
     * Change-detection heuristics. None is proof on its own, which is the point
     * worth teaching: privacy leaks come from several weak signals agreeing.
     */
    function privacyFindings(r) {
        const findings = [];
        const spendable = r.vout.filter((o) => o.script_type !== 'op_return');

        // 1. A round-numbered output is almost always the payment, so the other is change.
        const round = spendable.filter((o) => o.value_sats % 1000 === 0);
        if (spendable.length === 2 && round.length === 1) {
            const other = spendable.find((o) => o.value_sats % 1000 !== 0);
            findings.push({
                level: 'warn',
                title: 'Round-number payment gives away the change',
                text: `One output is a round ${fmt(round[0].value_sats)} sats while the other is an odd ${fmt(other.value_sats)}. People pay round amounts; wallets compute change down to the satoshi. Anyone watching can tell which output came back to the sender.`,
            });
        }

        // 2. Change usually reuses the wallet's own address type.
        const inputTypes = new Set(r.vin.map((v) => v.script_type));
        const matching = spendable.filter((o) => inputTypes.has(o.script_type));
        if (spendable.length === 2 && matching.length === 1 && inputTypes.size === 1) {
            findings.push({
                level: 'warn',
                title: 'Address type points at the change output',
                text: `Every input is ${esc(SCRIPT_LABELS[[...inputTypes][0]] || [...inputTypes][0])}, and exactly one output uses that same type. Wallets send change back to their own kind of address, so the type alone narrows down which output is the sender's.`,
            });
        }

        // 3. An output larger than the total spent is impossible; larger than all others is a hint.
        if (spendable.length === 2) {
            const [a, b] = spendable;
            const ratio = Math.max(a.value_sats, b.value_sats) / Math.max(1, Math.min(a.value_sats, b.value_sats));
            if (ratio > 20) {
                findings.push({
                    level: 'note',
                    title: 'Very lopsided outputs',
                    text: `One output is over ${Math.round(ratio)}× the other. Large imbalances make it easier to guess which side is the real payment.`,
                });
            }
        }

        // 4. Reusing an address across outputs links them publicly.
        const addresses = spendable.map((o) => o.address).filter(Boolean);
        if (new Set(addresses).size < addresses.length) {
            findings.push({
                level: 'danger',
                title: 'The same address is paid twice',
                text: 'Reusing an address publicly links these payments to the same owner, and to every other payment that address has ever received.',
            });
        }

        // 5. Mixed input types prove common ownership of different address kinds.
        if (inputTypes.size > 1) {
            findings.push({
                level: 'note',
                title: 'Different address types spent together',
                text: `This transaction spends ${inputTypes.size} different address types at once. Because every input must be signed by its owner, this proves one wallet controls all of them — that is the common-input-ownership heuristic.`,
            });
        }

        if (findings.length === 0) {
            findings.push({
                level: 'good',
                title: 'Nothing obvious leaks here',
                text: 'None of the usual change-detection heuristics fire on this transaction. That does not make it private, but the easy guesses do not work.',
            });
        }
        return findings;
    }

    function renderShape(r) {
        const shape = classifyShape(r);
        $('tx-shape').innerHTML = `
            <span class="shape-icon">${shape.icon}</span>
            <span class="shape-body">
                <b class="shape-name">${esc(shape.name)}</b>
                <span class="shape-text">${esc(shape.text)}</span>
            </span>`;

        const findings = privacyFindings(r);
        $('tx-privacy').innerHTML = findings.map((f) => `
            <div class="finding ${esc(f.level)}">
                <b>${esc(f.title)}</b>
                <span>${f.text}</span>
            </div>`).join('');
        stagger($('tx-privacy'));
    }

    // ── Block analytics ─────────────────────────────────────────────────────
    const MAX_BLOCK_WEIGHT = 4000000;

    /**
     * Two views of the fee market: how many blocks fell into each fee-rate band,
     * and how close each block came to the 4,000,000 weight-unit ceiling.
     */
    function renderBlockAnalytics(blocks) {
        const bands = [
            { label: '0–1', test: (v) => v <= 1, color: 'var(--rate-1)' },
            { label: '1–5', test: (v) => v <= 5, color: 'var(--rate-2)' },
            { label: '5–15', test: (v) => v <= 15, color: 'var(--rate-3)' },
            { label: '15–40', test: (v) => v <= 40, color: 'var(--rate-4)' },
            { label: '40–100', test: (v) => v <= 100, color: 'var(--rate-5)' },
            { label: '100+', test: () => true, color: 'var(--rate-6)' },
        ];

        const counts = bands.map(() => 0);
        blocks.forEach((b) => {
            const rate = b.block_stats.avg_fee_rate_sat_vb;
            counts[bands.findIndex((band) => band.test(rate))] += 1;
        });
        const tallest = Math.max(...counts, 1);

        $('block-histogram').innerHTML = `
            <div class="hist-bars">
                ${bands.map((band, i) => `
                    <div class="hist-col" title="${counts[i]} block(s) averaging ${esc(band.label)} sat/vB">
                        <span class="hist-count">${counts[i] || ''}</span>
                        <span class="hist-bar" style="height:${(counts[i] / tallest) * 100}%; background:${band.color}"></span>
                        <span class="hist-label">${esc(band.label)}</span>
                    </div>`).join('')}
            </div>
            <p class="hint" style="margin-top:6px">Average fee rate per block (sat/vB). Each bar counts how many
                blocks in this file sat in that band.</p>`;

        // Fullest blocks first: the ceiling is what makes block space scarce.
        const busiest = [...blocks]
            .sort((a, b) => b.block_stats.total_weight - a.block_stats.total_weight)
            .slice(0, 8);

        $('block-fill').innerHTML = busiest.map((b) => {
            const pct = Math.min(100, (b.block_stats.total_weight / MAX_BLOCK_WEIGHT) * 100);
            return `
                <div class="fill-row">
                    <span class="fill-label">#${fmt(b.coinbase.bip34_height)}</span>
                    <span class="fill-track"><span class="fill-bar" style="width:${pct}%"></span></span>
                    <span class="fill-value">${pct.toFixed(1)}% full &middot; ${fmt(b.tx_count)} txs</span>
                </div>`;
        }).join('');
        stagger($('block-fill'), '.fill-row');
    }

    // ── Fee-rate gauge ──────────────────────────────────────────────────────
    function renderGauge(r) {
        const rate = Number(r.fee_rate_sat_vb) || 0;
        const band = feeBand(rate);

        countUp($('gauge-value'), rate, (v) => v.toFixed(2));
        $('gauge-value').style.color = band.color;
        $('gauge-needle').style.left = `${ratePosition(rate)}%`;
        $('gauge-caption').innerHTML = r.total_input_sats
            ? `At <b>${rate.toFixed(2)} sat/vB</b> this is a <b style="color:${band.color}">${band.name}</b> fee rate — ${esc(band.note)}. ` +
              'Miners fill blocks with whichever transactions bid most per byte, so the rate — not the amount sent — decides how quickly it confirms.'
            : 'No spent-coin values were supplied, so the fee cannot be worked out for this transaction.';
    }

    // ── Value-flow ribbons ──────────────────────────────────────────────────
    /**
     * A Sankey diagram of the transaction: each input's value is poured into the
     * outputs in order, with the miner's fee as the final destination, so the
     * fee shows up as the sliver it usually is.
     */
    function renderSankey(r) {
        const svg = $('sankey');
        const inputsTotal = r.total_input_sats || (r.total_output_sats + r.fee_sats);

        const sources = r.vin.map((input, i) => ({
            value: input.prevout ? input.prevout.value_sats : 0,
            label: input.address ? shorten(input.address, 8, 6) : `input #${i}`,
            type: input.script_type,
        })).filter((n) => n.value > 0);

        const sinks = r.vout.map((out) => ({
            value: out.value_sats,
            label: out.address ? shorten(out.address, 8, 6) : `output #${out.n}`,
            type: out.script_type,
        }));
        if (r.fee_sats > 0) sinks.push({ value: r.fee_sats, label: 'miner fee', type: 'fee', isFee: true });

        if (sources.length === 0 || sinks.length === 0 || inputsTotal <= 0) {
            svg.innerHTML = '';
            svg.setAttribute('viewBox', '0 0 720 60');
            svg.setAttribute('height', 60);
            svg.innerHTML = '<text class="axis-title" x="360" y="34" text-anchor="middle">Not enough value information to draw the flow</text>';
            return;
        }

        const GAP = 5;
        const NODE_W = 13;
        const width = 720;
        const padTop = 22;
        const height = Math.max(180, Math.max(sources.length, sinks.length) * 26);
        const inner = height - padTop - 10;
        const rows = Math.max(sources.length, sinks.length);
        const scale = (value) => (value / inputsTotal) * (inner - GAP * rows);

        const layout = (nodes, x) => {
            let y = padTop;
            return nodes.map((node) => {
                const h = Math.max(2, scale(node.value));
                const box = { ...node, x, y, h };
                y += h + GAP;
                return box;
            });
        };

        const left = layout(sources, 0);
        const right = layout(sinks, width - NODE_W);

        const cursorL = left.map((node) => ({ node, used: 0 }));
        const cursorR = right.map((node) => ({ node, used: 0 }));
        const ribbons = [];
        let li = 0;
        let ri = 0;
        while (li < cursorL.length && ri < cursorR.length) {
            const source = cursorL[li];
            const sink = cursorR[ri];
            const moved = Math.min(source.node.value - source.used, sink.node.value - sink.used);

            if (moved > 0) {
                ribbons.push({
                    y0: source.node.y + scale(source.used),
                    y1: sink.node.y + scale(sink.used),
                    h: Math.max(1, scale(moved)),
                    color: sink.node.isFee ? 'var(--red)' : typeColor(source.node.type),
                    title: `${amount(moved)} ${unitLabel()} → ${sink.node.label}`,
                });
                source.used += moved;
                sink.used += moved;
            }
            if (source.node.value - source.used <= 0) li += 1;
            if (sink.node.value - sink.used <= 0) ri += 1;
        }

        const paths = ribbons.map((rib) => {
            const x0 = NODE_W;
            const x1 = width - NODE_W;
            const mid = (x0 + x1) / 2;
            const d = `M${x0},${rib.y0} C${mid},${rib.y0} ${mid},${rib.y1} ${x1},${rib.y1} ` +
                      `L${x1},${rib.y1 + rib.h} C${mid},${rib.y1 + rib.h} ${mid},${rib.y0 + rib.h} ${x0},${rib.y0 + rib.h} Z`;
            return `<path class="ribbon" d="${d}" fill="${rib.color}"><title>${esc(rib.title)}</title></path>`;
        }).join('');

        const nodes = (list, side) => list.map((n) => {
            const textX = side === 'start' ? NODE_W + 8 : width - NODE_W - 8;
            const color = n.isFee ? 'var(--red)' : typeColor(n.type);
            return `
                <rect x="${n.x}" y="${n.y}" width="${NODE_W}" height="${n.h}" rx="3" fill="${color}">
                    <title>${esc(n.label)} — ${esc(amount(n.value))} ${unitLabel()}</title>
                </rect>
                ${n.h >= 11 ? `<text class="node-value" x="${textX}" y="${n.y + n.h / 2 + 4}" text-anchor="${side}">${esc(amount(n.value))}</text>` : ''}`;
        }).join('');

        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('height', height);
        svg.innerHTML = `
            <text class="axis-title" x="0" y="12">Inputs — coins spent</text>
            <text class="axis-title" x="${width}" y="12" text-anchor="end">Outputs — coins created</text>
            ${paths}${nodes(left, 'start')}${nodes(right, 'end')}`;
        svg.querySelectorAll('.ribbon').forEach((node, i) => node.style.setProperty('--i', i));
    }

    // ── Raw-byte inspector ──────────────────────────────────────────────────
    const HEX_COLORS = {
        version: '#4f8cff',
        marker: '#b197fc',
        count: '#8a94a8',
        outpoint: '#f7931a',
        script: '#2bd576',
        sequence: '#e0245e',
        value: '#f0d000',
        witness: '#12b886',
        locktime: '#ff8787',
    };

    /**
     * Walks the raw transaction the same way the parser does and records the
     * byte range of every field, so the hex can be coloured in place.
     */
    function mapTxFields(hex) {
        const fields = [];
        let at = 0;

        const take = (bytes, kind, label) => {
            fields.push({ start: at, end: at + bytes * 2, kind, label });
            at += bytes * 2;
        };
        const peek = (offset = 0) => parseInt(hex.slice(at + offset * 2, at + offset * 2 + 2), 16);

        // Compact size: 1, 3, 5 or 9 bytes depending on the leading byte.
        const compact = (kind, label) => {
            const first = peek();
            let size = 1;
            let value = first;
            if (first === 0xfd) { size = 3; value = parseInt(hex.slice(at + 2, at + 6).match(/../g).reverse().join(''), 16); }
            else if (first === 0xfe) { size = 5; value = parseInt(hex.slice(at + 2, at + 10).match(/../g).reverse().join(''), 16); }
            else if (first === 0xff) { size = 9; value = Number(BigInt(`0x${hex.slice(at + 2, at + 18).match(/../g).reverse().join('')}`)); }
            take(size, kind, `${label} = ${value}`);
            return value;
        };

        take(4, 'version', 'version');

        const segwit = peek() === 0x00 && peek(1) === 0x01;
        if (segwit) take(2, 'marker', 'SegWit marker + flag');

        const vinCount = compact('count', 'input count');
        for (let i = 0; i < vinCount; i += 1) {
            take(32, 'outpoint', `input #${i} — previous txid`);
            take(4, 'outpoint', `input #${i} — previous output index`);
            const scriptLen = compact('count', `input #${i} scriptSig length`);
            if (scriptLen > 0) take(scriptLen, 'script', `input #${i} scriptSig`);
            take(4, 'sequence', `input #${i} sequence (RBF / relative timelock)`);
        }

        const voutCount = compact('count', 'output count');
        for (let i = 0; i < voutCount; i += 1) {
            take(8, 'value', `output #${i} amount in satoshis`);
            const scriptLen = compact('count', `output #${i} script length`);
            if (scriptLen > 0) take(scriptLen, 'script', `output #${i} locking script`);
        }

        if (segwit) {
            for (let i = 0; i < vinCount; i += 1) {
                const items = compact('count', `input #${i} witness item count`);
                for (let j = 0; j < items; j += 1) {
                    const len = compact('count', `input #${i} witness item ${j} length`);
                    if (len > 0) take(len, 'witness', `input #${i} witness item ${j}`);
                }
            }
        }

        take(4, 'locktime', 'nLockTime');
        return fields;
    }

    function renderHexMap(rawHex) {
        const container = $('hexmap');
        if (!rawHex) {
            container.innerHTML = '<div class="empty">No raw transaction available.</div>';
            $('hex-legend').innerHTML = '';
            return;
        }

        let fields;
        try {
            fields = mapTxFields(rawHex.toLowerCase());
        } catch (err) {
            container.textContent = rawHex;
            $('hex-legend').innerHTML = '';
            return;
        }

        container.innerHTML = fields.map((field) => {
            const slice = rawHex.slice(field.start, field.end);
            // Very long fields are truncated so the map stays scannable.
            const shown = slice.length > 96 ? `${slice.slice(0, 64)}…${slice.slice(-16)}` : slice;
            return `<span class="hexf" style="color:${HEX_COLORS[field.kind]}"
                title="${esc(field.label)} — ${slice.length / 2} byte(s)">${esc(shown)}</span>`;
        }).join(' ');

        const used = [...new Set(fields.map((f) => f.kind))];
        const names = {
            version: 'version', marker: 'SegWit marker', count: 'lengths & counts',
            outpoint: 'which coin is spent', script: 'scripts', sequence: 'sequence',
            value: 'amounts', witness: 'signatures (witness)', locktime: 'locktime',
        };
        $('hex-legend').innerHTML = used.map((kind) =>
            `<span><i class="swatch" style="background:${HEX_COLORS[kind]}"></i>${esc(names[kind] || kind)}</span>`).join('');
    }

    // ── Unit toggle ─────────────────────────────────────────────────────────
    function setUnit(next) {
        if (unit === next) return;
        unit = next;
        $('unit-sats').classList.toggle('active', next === 'sats');
        $('unit-btc').classList.toggle('active', next === 'btc');
        document.querySelectorAll('.unit-word').forEach((node) => { node.textContent = unitLabel(); });
        if (lastTx) renderTx(lastTx, false);
    }

    $('unit-sats').addEventListener('click', () => setUnit('sats'));
    $('unit-btc').addEventListener('click', () => setUnit('btc'));

    // ── Shared helpers ──────────────────────────────────────────────────────
    function renderWarnings(container, warnings) {
        if (!warnings || warnings.length === 0) {
            container.classList.add('hidden');
            return;
        }
        container.classList.remove('hidden');
        container.innerHTML = warnings.map((w) => {
            const info = WARNING_INFO[w.code] || { level: 'warn', icon: '⚠️', title: w.code, text: '' };
            return `
                <div class="warn ${info.level === 'danger' ? 'danger' : info.level === 'note' ? 'note' : ''}">
                    <span class="warn-icon">${info.icon}</span>
                    <span class="warn-body">
                        <span class="warn-code">${esc(w.code)}</span>
                        <b>${esc(info.title)}</b>
                        <span class="warn-text"> — ${esc(info.text)}</span>
                    </span>
                </div>`;
        }).join('');
    }

    function showError(el, code, message) {
        el.innerHTML = `<b>${esc(code)}</b> — ${esc(message)}`;
        el.classList.remove('hidden');
    }

    function hide(el) {
        el.classList.add('hidden');
    }

    async function checkHealth() {
        try {
            const data = await (await fetch('/api/health')).json();
            $('api-health').textContent = data.ok ? 'API healthy' : 'API error';
            $('api-health').className = `pill ${data.ok ? 'pill-ok' : 'pill-bad'}`;
        } catch (e) {
            $('api-health').textContent = 'API unreachable';
            $('api-health').className = 'pill pill-bad';
        }
    }

    loadTxFixtures();
    checkHealth();
});
