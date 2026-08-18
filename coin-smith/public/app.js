/**
 * Coin Smith web UI.
 *
 * Posts a fixture to /api/build and renders the report as a walkthrough:
 * what was spent, where it went, what it cost, and which rules apply.
 */
document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);

    const el = {
        picker: $('fixture-picker'),
        fixtureDescription: $('fixture-description'),
        jsonInput: $('json-input'),
        fileUpload: $('file-upload'),
        buildBtn: $('build-btn'),
        error: $('error-message'),
        preview: $('fixture-preview'),

        resultsEmpty: $('results-empty'),
        results: $('results'),
        plainSummary: $('plain-summary'),

        statInputsCount: $('stat-inputs-count'),
        statInputsValue: $('stat-inputs-value'),
        statOutputsCount: $('stat-outputs-count'),
        statOutputsValue: $('stat-outputs-value'),
        statFee: $('stat-fee'),
        statFeeRate: $('stat-fee-rate'),
        statVbytes: $('stat-vbytes'),

        warnings: $('warnings'),
        countInputs: $('count-inputs'),
        countOutputs: $('count-outputs'),
        inputsList: $('inputs-list'),
        outputsList: $('outputs-list'),
        flowInTotal: $('flow-in-total'),
        flowOutTotal: $('flow-out-total'),
        flowFee: $('flow-fee'),
        flowVbytes: $('flow-vbytes'),
        balanceBar: $('balance-bar'),
        balanceCheck: $('balance-check'),

        feeMath: $('fee-math'),
        rbfStatus: $('rbf-status'),
        rbfExplain: $('rbf-explain'),
        rbfCode: $('rbf-code'),
        locktimeBadge: $('locktime-badge'),
        locktimeExplain: $('locktime-explain'),
        locktimeCode: $('locktime-code'),

        gaugeValue: $('gauge-value'),
        gaugeNeedle: $('gauge-needle'),
        gaugeCaption: $('gauge-caption'),
        poolSection: $('pool-section'),
        utxoPool: $('utxo-pool'),
        poolLegend: $('pool-legend'),
        sankey: $('sankey'),
        sizeStack: $('size-stack'),
        sizeKey: $('size-key'),
        psbtDecoded: $('psbt-decoded'),
        psbtTabDecoded: $('psbt-tab-decoded'),
        psbtTabRaw: $('psbt-tab-raw'),
        unitSats: $('unit-sats'),
        unitBtc: $('unit-btc'),

        walletFindings: $('wallet-findings'),
        simSlider: $('sim-slider'),
        simRate: $('sim-rate'),
        simGrid: $('sim-grid'),

        strategySection: $('strategy-section'),
        strategies: $('strategies'),
        psbt: $('psbt-content'),
        copyPsbt: $('copy-psbt'),
        network: $('network-status'),
        apiHealth: $('api-health'),
    };

    const DUST = 546;
    const SATS_PER_BTC = 100000000;

    /** Display unit, toggled in the header. Amounts are always sats internally. */
    let unit = 'sats';

    /** The most recent successful build, re-rendered when the unit changes. */
    let lastReport = null;
    let lastFixture = null;

    const fmt = (n) => Number(n).toLocaleString('en-US');

    /** Formats a satoshi amount in whichever unit the reader has selected. */
    const amount = (sats) => unit === 'btc'
        ? (sats / SATS_PER_BTC).toFixed(8)
        : fmt(sats);

    const unitLabel = () => (unit === 'btc' ? 'BTC' : 'sats');

    /**
     * Fee-rate colour ramp, matching the green-to-red banding block explorers
     * use so a rate can be judged without reading the number.
     */
    function feeBand(rate) {
        if (rate <= 1) return { color: 'var(--rate-1)', name: 'minimum', note: 'the cheapest rate the network will relay' };
        if (rate <= 5) return { color: 'var(--rate-2)', name: 'low', note: 'fine when you are not in a hurry' };
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

    /** Distinct colours per script type, reused across every chart. */
    const TYPE_COLORS = {
        p2pkh: '#e0245e',
        p2sh: '#f2620f',
        'p2sh-p2wpkh': '#f7931a',
        'p2sh-p2wsh': '#f0a500',
        p2wpkh: '#2bd576',
        p2wsh: '#12b886',
        p2tr: '#4f8cff',
        op_return: '#8a94a8',
        unknown: '#6c7a94',
    };
    const typeColor = (type) => TYPE_COLORS[type] || TYPE_COLORS.unknown;

    /** Sets --i on each child so CSS can stagger their entrance animations. */
    function stagger(container, selector = ':scope > *') {
        container.querySelectorAll(selector).forEach((node, i) => {
            node.style.setProperty('--i', i);
        });
    }

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /**
     * Counts an element up to its final value. Numbers that animate into place
     * are much easier to compare than ones that simply appear.
     */
    function countUp(node, to, format = fmt, duration = 620) {
        // Write the final value first: requestAnimationFrame never fires in a
        // background tab, and the real figure must be there regardless.
        node.textContent = format(to);
        if (prefersReducedMotion) return;

        const from = 0;
        const start = performance.now();

        const step = (now) => {
            const t = Math.min(1, (now - start) / duration);
            // Ease-out cubic: fast at first, settling gently on the real figure.
            const eased = 1 - Math.pow(1 - t, 3);
            node.textContent = format(from + (to - from) * eased);
            if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    /** Count-up formatter that respects the selected unit. */
    const countFormat = (value) => (unit === 'btc'
        ? (value / SATS_PER_BTC).toFixed(8)
        : fmt(Math.round(value)));

    const shorten = (text, head = 10, tail = 8) =>
        !text ? '—' : text.length <= head + tail + 3 ? text : `${text.slice(0, head)}…${text.slice(-tail)}`;

    /** Escapes text before it goes anywhere near innerHTML. */
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** Plain-language notes for each warning the builder can emit. */
    const WARNING_INFO = {
        HIGH_FEE: { level: 'danger', icon: '🔥', title: 'Unusually high fee', text: 'This transaction pays far more than a normal transaction. Double-check the fee rate before signing.' },
        DUST_CHANGE: { level: 'danger', icon: '🧹', title: 'Dust change', text: `The change output is under ${DUST} sats, which costs more to spend later than it is worth.` },
        SEND_ALL: { level: 'info', icon: '📤', title: 'Send-all — no change returned', text: 'The leftover was too small to be worth keeping as a coin, so all of it went to the miner as fee.' },
        RBF_SIGNALING: { level: 'info', icon: '🔁', title: 'Replaceable (RBF)', text: 'You can re-send this transaction later with a higher fee if it is confirming too slowly. Until it confirms, it is not final.' },
        DUST_OUTPUT: { level: 'danger', icon: '⚠️', title: 'Dust payment', text: `A payment is below the ${DUST} sat dust threshold and may be rejected by the network.` },
        NO_CHANGE_ADDRESS: { level: 'warn', icon: '📭', title: 'No change address supplied', text: 'Without a change address, any leftover value has to be given to the miner.' },
        MANY_INPUTS: { level: 'warn', icon: '🧮', title: 'Many inputs', text: 'Spending lots of small coins makes the transaction large, so the fee is high.' },
        ADDRESS_REUSE: { level: 'warn', icon: '👁️', title: 'Address reuse', text: 'The same address is paid more than once, which links these payments together publicly.' },
    };

    /** One-line descriptions for the bundled sample fixtures. */
    const describeFixture = (name) => {
        const rules = [
            [/exact_match/, 'The coin covers the payment and fee exactly — nothing is left for change.'],
            [/dust_boundary/, 'The leftover lands exactly on the 546 sat dust threshold, so change is just barely worth keeping.'],
            [/change_becomes_dust/, 'The leftover would be dust, so the change output is dropped and it becomes fee instead.'],
            [/send_all/, 'No change is created — everything left over is paid to the miner.'],
            [/consolidation|small_utxos/, 'Many tiny coins are swept together, which makes for a big, expensive transaction.'],
            [/max_inputs/, 'A wallet policy caps how many coins may be spent.'],
            [/duplicate_payment/, 'The same address is paid twice in one transaction, which is legal.'],
            [/high_fee/, 'The fee is high enough to trigger a safety warning.'],
            [/anti_fee_sniping/, 'Locks to the current block height so a miner cannot profitably re-mine it.'],
            [/rbf_.*locktime|locktime.*rbf/, 'Combines Replace-by-Fee with an explicit time lock.'],
            [/^rbf/, 'Opts into Replace-by-Fee, so the fee can be bumped later.'],
            [/locktime_boundary/, 'Sits on the boundary between a block height and a unix timestamp lock.'],
            [/locktime/, 'Sets a time lock on the transaction.'],
            [/p2tr|taproot/, 'Uses Taproot coins, the cheapest input type to spend.'],
            [/p2pkh/, 'Uses a legacy coin, the most expensive input type to spend.'],
            [/p2sh/, 'Uses a wrapped-segwit coin.'],
            [/mixed|large_mixed/, 'Mixes several address types in one transaction.'],
            [/many_payments|multi_payment/, 'Pays several destinations at once.'],
            [/multi_input/, 'Needs more than one coin to cover the payment.'],
            [/large_utxo_pool/, 'Picks from a large pool of available coins.'],
        ];
        const match = rules.find(([re]) => re.test(name));
        return match ? match[1] : 'A standard payment with change returned to your wallet.';
    };

    // ── Fixture loading ─────────────────────────────────────────────────────
    async function loadFixtureList() {
        try {
            const res = await fetch('/api/fixtures');
            const data = await res.json();
            if (!data.ok) throw new Error('unavailable');

            el.picker.innerHTML = '<option value="">— choose a sample scenario —</option>';
            data.fixtures.forEach((name) => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name.replace(/^hidden_/, '').replace(/_/g, ' ');
                el.picker.appendChild(option);
            });
        } catch (err) {
            el.picker.innerHTML = '<option value="">No samples available — paste JSON below</option>';
        }
    }

    el.picker.addEventListener('change', async () => {
        const name = el.picker.value;
        if (!name) return;
        try {
            const res = await fetch(`/api/fixtures/${encodeURIComponent(name)}`);
            const fixture = await res.json();
            el.jsonInput.value = JSON.stringify(fixture, null, 2);
            el.fixtureDescription.textContent = describeFixture(name);
            hideError();
            renderPreview();
        } catch (err) {
            showError('LOAD_FAILED', 'Could not load that sample fixture.');
        }
    });

    el.fileUpload.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            el.jsonInput.value = e.target.result;
            el.picker.value = '';
            hideError();
            renderPreview();
        };
        reader.onerror = () => showError('READ_FAILED', 'Could not read that file.');
        reader.readAsText(file);
    });

    el.jsonInput.addEventListener('input', renderPreview);

    /** Summarises the pasted fixture before anything is built. */
    function renderPreview() {
        const raw = el.jsonInput.value.trim();
        if (!raw) {
            el.preview.innerHTML = '<div class="empty">Load a fixture to preview it.</div>';
            return;
        }
        let fixture;
        try {
            fixture = JSON.parse(raw);
        } catch (err) {
            el.preview.innerHTML = '<div class="empty">This is not valid JSON yet.</div>';
            return;
        }

        const utxos = Array.isArray(fixture.utxos) ? fixture.utxos : [];
        const payments = Array.isArray(fixture.payments) ? fixture.payments : [];
        const available = utxos.reduce((sum, u) => sum + (u.value_sats || 0), 0);
        const owed = payments.reduce((sum, p) => sum + (p.value_sats || 0), 0);

        const rows = [
            ['Coins available', `${fmt(utxos.length)} · ${fmt(available)} sats`],
            ['Payments to make', `${fmt(payments.length)} · ${fmt(owed)} sats`],
            ['Fee rate target', `${fixture.fee_rate_sat_vb ?? '—'} sat/vB`],
            ['Change address', fixture.change ? 'provided' : 'none (send-all)'],
            ['Replaceable (RBF)', fixture.rbf === true ? 'yes' : 'no'],
        ];
        if (fixture.locktime !== undefined) rows.push(['Time lock requested', fmt(fixture.locktime)]);
        if (fixture.policy && fixture.policy.max_inputs) rows.push(['Max inputs allowed', fmt(fixture.policy.max_inputs)]);

        el.preview.innerHTML = rows
            .map(([label, value]) => `<div class="preview-row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`)
            .join('');
    }

    // ── Build ───────────────────────────────────────────────────────────────
    el.buildBtn.addEventListener('click', async () => {
        const raw = el.jsonInput.value.trim();
        if (!raw) {
            showError('NO_INPUT', 'Load a sample scenario or paste a fixture first.');
            return;
        }

        let fixture;
        try {
            fixture = JSON.parse(raw);
        } catch (err) {
            showError('INVALID_JSON', `That is not valid JSON — ${err.message}`);
            return;
        }

        el.buildBtn.disabled = true;
        el.buildBtn.innerHTML = '<span class="spinner"></span>Building…';
        hideError();

        try {
            const res = await fetch('/api/build', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fixture),
            });
            const report = await res.json();
            if (!report.ok) {
                showError(report.error.code, report.error.message);
                el.results.classList.add('hidden');
                el.resultsEmpty.classList.remove('hidden');
            } else {
                lastFixture = fixture;
                render(report);
                el.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        } catch (err) {
            showError('API_UNREACHABLE', 'Could not reach the builder API. Is the server still running?');
        } finally {
            el.buildBtn.disabled = false;
            el.buildBtn.textContent = 'Build transaction';
        }
    });

    el.copyPsbt.addEventListener('click', () => {
        const text = el.psbt.textContent;
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            el.copyPsbt.textContent = 'Copied';
            setTimeout(() => { el.copyPsbt.textContent = 'Copy'; }, 1600);
        });
    });

    function showError(code, message) {
        el.error.innerHTML = `<b>${esc(code)}</b> — ${esc(message)}`;
        el.error.classList.remove('hidden');
    }

    function hideError() {
        el.error.classList.add('hidden');
    }

    // ── Rendering ───────────────────────────────────────────────────────────
    function render(report) {
        lastReport = report;
        el.resultsEmpty.classList.add('hidden');
        el.results.classList.remove('hidden');
        el.network.textContent = report.network;

        const inputsTotal = report.selected_inputs.reduce((sum, i) => sum + i.value_sats, 0);
        const outputsTotal = report.outputs.reduce((sum, o) => sum + o.value_sats, 0);
        const change = report.change_index === null ? null : report.outputs[report.change_index];
        const paymentsTotal = outputsTotal - (change ? change.value_sats : 0);

        renderSummary(report, inputsTotal, paymentsTotal, change);

        countUp(el.statInputsCount, report.selected_inputs.length, (v) => fmt(Math.round(v)));
        countUp(el.statInputsValue, inputsTotal, countFormat);
        countUp(el.statOutputsCount, report.outputs.length, (v) => fmt(Math.round(v)));
        countUp(el.statOutputsValue, outputsTotal, countFormat);
        countUp(el.statFee, report.fee_sats, countFormat);
        countUp(el.statFeeRate, report.fee_rate_sat_vb, (v) => v.toFixed(2));
        countUp(el.statVbytes, report.vbytes, (v) => fmt(Math.round(v)));

        renderGauge(report);
        renderWarnings(report.warnings);
        renderPool(report, lastFixture);
        walletFindings(report, lastFixture, change);
        renderFlow(report, inputsTotal, outputsTotal, paymentsTotal, change);
        renderSankey(report, inputsTotal);
        renderFeeMath(report, change);
        renderSizeBreakdown(report);
        renderRules(report);
        renderStrategies(report);
        renderPsbt(report);

        const baseRate = report.summary ? report.summary.target_fee_rate_sat_vb : Math.round(report.fee_rate_sat_vb);
        el.simSlider.value = Math.min(120, Math.max(1, baseRate));
        el.simRate.textContent = el.simSlider.value;
        runSimulation(Number(el.simSlider.value));
    }

    /** The headline narrative, written for someone new to Bitcoin. */
    function renderSummary(report, inputsTotal, paymentsTotal, change) {
        const coins = report.selected_inputs.length;
        const payees = report.outputs.filter((o) => !o.is_change).length;

        const parts = [
            `Your wallet handed over <b>${coins} coin${coins === 1 ? '' : 's'}</b> worth <b>${fmt(inputsTotal)} sats</b> in total,`,
            `paid <b>${fmt(paymentsTotal)} sats</b> to <b>${payees} destination${payees === 1 ? '' : 's'}</b>,`,
        ];

        parts.push(change
            ? `got <b>${fmt(change.value_sats)} sats</b> back as change,`
            : 'kept nothing back as change,');

        parts.push(`and paid <b>${fmt(report.fee_sats)} sats</b> to the miner for including it in a block.`);

        if (!change) {
            parts.push('The leftover was too small to be worth keeping as a separate coin, so it became part of the fee.');
        }
        if (report.rbf_signaling) {
            parts.push('This transaction is <b>replaceable</b>: you can re-send it with a higher fee if it is taking too long.');
        }
        if (report.locktime > 0) {
            const kind = report.locktime_type === 'unix_timestamp' ? 'a point in time' : 'a block height';
            parts.push(`It is also time-locked to ${kind} (<b>${fmt(report.locktime)}</b>), so it cannot confirm before then.`);
        }

        el.plainSummary.innerHTML = parts.join(' ');
    }

    function renderWarnings(warnings) {
        if (!warnings || warnings.length === 0) {
            el.warnings.classList.add('hidden');
            el.warnings.innerHTML = '';
            return;
        }
        el.warnings.classList.remove('hidden');
        el.warnings.innerHTML = warnings.map((warning) => {
            const info = WARNING_INFO[warning.code] || { level: 'warn', icon: '⚠️', title: warning.code, text: warning.message || '' };
            const level = info.level === 'danger' ? 'danger' : info.level === 'info' ? 'note' : '';
            return `
                <div class="warn ${level}">
                    <span class="warn-icon">${info.icon}</span>
                    <span class="warn-body">
                        <span class="warn-code">${esc(warning.code)}</span>
                        <b>${esc(info.title)}</b>
                        <span class="warn-text"> — ${esc(info.text)}</span>
                    </span>
                </div>`;
        }).join('');
        stagger(el.warnings);
    }

    function renderFlow(report, inputsTotal, outputsTotal, paymentsTotal, change) {
        el.countInputs.textContent = fmt(report.selected_inputs.length);
        el.countOutputs.textContent = fmt(report.outputs.length);
        el.flowInTotal.textContent = amount(inputsTotal);
        el.flowOutTotal.textContent = amount(outputsTotal);
        el.flowFee.textContent = amount(report.fee_sats);
        el.flowVbytes.textContent = `${fmt(report.vbytes)} vB`;

        el.inputsList.innerHTML = report.selected_inputs.map((input) => `
            <div class="item">
                <div class="item-top">
                    <span class="item-addr" title="${esc(input.txid)}:${esc(input.vout)}">${esc(shorten(input.txid))}:${esc(input.vout)}</span>
                    <span class="item-type">${esc(input.script_type)}</span>
                </div>
                <div class="item-bottom">
                    <span class="item-amount">${esc(amount(input.value_sats))} <span>${unitLabel()}</span></span>
                    <span class="item-addr" title="${esc(input.address || '')}">${esc(shorten(input.address || '', 8, 6))}</span>
                </div>
            </div>`).join('');

        el.outputsList.innerHTML = report.outputs.map((output) => `
            <div class="item ${output.is_change ? 'is-change' : 'is-payment'}">
                <div class="item-top">
                    <span class="item-addr" title="${esc(output.address || output.script_pubkey_hex)}">${esc(shorten(output.address || output.script_pubkey_hex, 14, 8))}</span>
                    <span class="item-type">${esc(output.script_type)}</span>
                </div>
                <div class="item-bottom">
                    <span class="item-amount">${esc(amount(output.value_sats))} <span>${unitLabel()}</span></span>
                    <span class="tag ${output.is_change ? 'tag-change' : 'tag-pay'}">${output.is_change ? 'CHANGE' : 'PAYMENT'}</span>
                </div>
            </div>`).join('');

        // Proportional bar: payments / change / fee.
        const pct = (value) => (inputsTotal > 0 ? (value / inputsTotal) * 100 : 0);
        const segments = [
            { cls: 'bar-pay', value: paymentsTotal, label: 'payments' },
            change ? { cls: 'bar-change', value: change.value_sats, label: 'change' } : null,
            { cls: 'bar-fee', value: report.fee_sats, label: 'fee' },
        ].filter(Boolean);

        el.balanceBar.innerHTML = segments.map((seg) => {
            const width = pct(seg.value);
            return `<div class="bar-seg ${seg.cls}" style="width:${width}%" title="${esc(seg.label)}: ${amount(seg.value)} ${unitLabel()}">${width > 12 ? esc(seg.label) : ''}</div>`;
        }).join('');
        stagger(el.balanceBar);
        stagger(el.inputsList);
        stagger(el.outputsList);

        const balanced = inputsTotal === outputsTotal + report.fee_sats;
        el.balanceCheck.textContent =
            `${amount(inputsTotal)} in  =  ${amount(outputsTotal)} out  +  ${amount(report.fee_sats)} fee  ${balanced ? '✓ balanced' : '✗ MISMATCH'}`;
    }

    function renderFeeMath(report, change) {
        const target = report.summary ? report.summary.target_fee_rate_sat_vb : report.fee_rate_sat_vb;
        const required = Math.ceil(report.vbytes * target);

        const rows = [
            ['Transaction size', `${fmt(report.vbytes)} vB`],
            ['Fee rate you asked for', `${target} sat/vB`],
            ['Minimum fee required', `ceil(${fmt(report.vbytes)} × ${target}) = ${fmt(required)} sats`],
        ];

        if (change) {
            rows.push(['Change output', `${fmt(change.value_sats)} sats returned to you`]);
            rows.push(['Why not more?', 'Adding the change output made the transaction bigger, so the fee went up too.']);
        } else {
            rows.push(['Leftover after payments', `${fmt(report.fee_sats)} sats`]);
            rows.push(['Why no change?', `The leftover was below the ${DUST} sat dust limit, so keeping it would cost more to spend than it is worth.`]);
        }

        rows.push(['Fee actually paid', `${fmt(report.fee_sats)} sats`]);

        el.feeMath.innerHTML = rows.map(([label, value], i) => `
            <div class="math-row ${i === rows.length - 1 ? 'total' : ''}">
                <span>${esc(label)}</span><b>${esc(value)}</b>
            </div>`).join('');
    }

    function renderRules(report) {
        const sequence = report.summary ? report.summary.nsequence : (report.rbf_signaling ? '0xfffffffd' : '0xffffffff');

        el.rbfStatus.textContent = report.rbf_signaling ? 'on' : 'off';
        el.rbfStatus.className = `badge ${report.rbf_signaling ? 'on' : ''}`;
        el.rbfExplain.textContent = report.rbf_signaling
            ? 'Every input is flagged as replaceable, so you can re-send this transaction with a higher fee if it is confirming too slowly. Until it confirms, treat it as not final.'
            : 'This transaction is not marked replaceable, so the fee cannot be bumped after broadcasting. Recipients can treat it as final sooner.';
        el.rbfCode.textContent = `nSequence = ${sequence} (on all ${report.selected_inputs.length} input${report.selected_inputs.length === 1 ? '' : 's'})`;

        const type = report.locktime_type;
        el.locktimeBadge.textContent = type === 'none' ? 'none' : type.replace('_', ' ');
        el.locktimeBadge.className = `badge ${type === 'none' ? '' : 'warn'}`;
        el.locktimeExplain.textContent = type === 'none'
            ? 'No time lock: this transaction can be confirmed in the very next block.'
            : type === 'block_height'
                ? `Locked until block ${fmt(report.locktime)}. Miners cannot include it before the chain reaches that height, which also stops them re-mining recent blocks to steal it.`
                : `Locked until the unix timestamp ${fmt(report.locktime)}. It cannot confirm before that moment in time.`;
        el.locktimeCode.textContent = `nLockTime = ${report.locktime} → ${type}`;
    }

    function renderStrategies(report) {
        const candidates = report.summary && report.summary.strategy_candidates;
        if (!candidates || candidates.length === 0) {
            el.strategySection.classList.add('hidden');
            return;
        }
        el.strategySection.classList.remove('hidden');

        // Bars are scaled against the most expensive candidate, so the winning
        // margin is visible rather than just stated.
        const worst = Math.max(...candidates.map((c) => c.fee_sats), 1);

        el.strategies.className = 'chart-rows';
        el.strategies.innerHTML = candidates.map((candidate) => {
            const chosen = candidate.strategy === report.strategy;
            const width = (candidate.fee_sats / worst) * 100;
            return `
                <div class="chart-row ${chosen ? 'chosen' : ''}">
                    <span class="chart-label">
                        ${esc(candidate.strategy.replace(/_/g, ' '))}
                        ${chosen ? '<span class="tag tag-change">CHOSEN</span>' : ''}
                    </span>
                    <span class="chart-track"><span class="chart-fill" style="width:${width}%"></span></span>
                    <span class="chart-value">${esc(amount(candidate.fee_sats))} ${unitLabel()} &middot;
                        ${fmt(candidate.input_count)} in &middot; ${fmt(candidate.vbytes)} vB &middot;
                        ${candidate.creates_change ? 'change' : 'send-all'}</span>
                </div>`;
        }).join('');
        stagger(el.strategies);
    }

    // ── Fee-rate gauge ──────────────────────────────────────────────────────
    function renderGauge(report) {
        const rate = report.fee_rate_sat_vb;
        const band = feeBand(rate);

        countUp(el.gaugeValue, rate, (v) => v.toFixed(2));
        el.gaugeValue.style.color = band.color;
        el.gaugeNeedle.style.left = `${ratePosition(rate)}%`;
        el.gaugeCaption.innerHTML =
            `At <b>${rate.toFixed(2)} sat/vB</b> this is a <b style="color:${band.color}">${band.name}</b> fee rate — ${esc(band.note)}. ` +
            `Miners fill blocks with whichever transactions bid most per byte, so the rate — not the amount sent — decides how fast it confirms.`;
    }

    // ── UTXO pool ───────────────────────────────────────────────────────────
    /**
     * Shows the whole wallet, not just the coins that were spent, so the effect
     * of coin selection is visible. The fixture is the only source of the full
     * pool; the report lists selected inputs alone.
     */
    function renderPool(report, fixture) {
        const pool = fixture && Array.isArray(fixture.utxos) ? fixture.utxos : [];
        if (pool.length === 0) {
            el.poolSection.classList.add('hidden');
            return;
        }
        el.poolSection.classList.remove('hidden');

        const picked = new Set(report.selected_inputs.map((i) => `${i.txid}:${i.vout}`));
        const largest = Math.max(...pool.map((u) => u.value_sats || 0), 1);

        el.utxoPool.innerHTML = pool.map((utxo) => {
            const key = `${utxo.txid}:${utxo.vout}`;
            const isPicked = picked.has(key);
            const type = utxo.script_type || guessType(utxo.script_pubkey_hex);
            const fillPct = Math.max(6, ((utxo.value_sats || 0) / largest) * 100);
            return `
                <div class="coin ${isPicked ? 'picked' : ''}" title="${esc(key)}\n${fmt(utxo.value_sats)} sats\n${esc(type)}${isPicked ? '\nSELECTED' : '\nnot used'}">
                    <span class="coin-fill" style="height:${fillPct}%; background:${isPicked ? typeColor(type) + '33' : ''}"></span>
                    <span class="coin-amount">${esc(amount(utxo.value_sats || 0))}</span>
                    <span class="coin-type" style="color:${isPicked ? typeColor(type) : ''}">${esc(type)}</span>
                </div>`;
        }).join('');
        stagger(el.utxoPool);

        const chosen = pool.filter((u) => picked.has(`${u.txid}:${u.vout}`));
        const chosenValue = chosen.reduce((sum, u) => sum + (u.value_sats || 0), 0);
        const poolValue = pool.reduce((sum, u) => sum + (u.value_sats || 0), 0);

        el.poolLegend.innerHTML = `
            <span><i class="swatch on"></i>Spent: <b>${fmt(chosen.length)}</b> of ${fmt(pool.length)} coins &middot; <b>${esc(amount(chosenValue))}</b> ${unitLabel()}</span>
            <span><i class="swatch off"></i>Left alone: <b>${fmt(pool.length - chosen.length)}</b> coins &middot; <b>${esc(amount(poolValue - chosenValue))}</b> ${unitLabel()}</span>
            <span>Strategy: <b>${esc(report.strategy.replace(/_/g, ' '))}</b></span>`;
    }

    /** Best-effort script type when a fixture omits it. */
    function guessType(hex) {
        if (!hex) return 'unknown';
        if (/^0014[0-9a-f]{40}$/i.test(hex)) return 'p2wpkh';
        if (/^0020[0-9a-f]{64}$/i.test(hex)) return 'p2wsh';
        if (/^5120[0-9a-f]{64}$/i.test(hex)) return 'p2tr';
        if (/^a914[0-9a-f]{40}87$/i.test(hex)) return 'p2sh';
        if (/^76a914[0-9a-f]{40}88ac$/i.test(hex)) return 'p2pkh';
        return 'unknown';
    }

    // ── Value-flow ribbons ──────────────────────────────────────────────────
    /**
     * A Sankey diagram of the transaction: every input's value is poured into
     * the outputs in order, with the miner's fee as the final destination.
     * Ribbon thickness is proportional to the satoshis carried, so the fee is
     * visible as the sliver it usually is.
     */
    function renderSankey(report, inputsTotal) {
        const svg = el.sankey;
        const sources = report.selected_inputs.map((input) => ({
            value: input.value_sats,
            label: `${shorten(input.txid, 6, 4)}:${input.vout}`,
            type: input.script_type,
        }));
        const sinks = report.outputs.map((output) => ({
            value: output.value_sats,
            label: output.address ? shorten(output.address, 8, 6) : 'script',
            type: output.script_type,
            kind: output.is_change ? 'change' : 'payment',
        }));
        if (report.fee_sats > 0) {
            sinks.push({ value: report.fee_sats, label: 'miner fee', type: 'fee', kind: 'fee' });
        }

        const GAP = 5;
        const NODE_W = 13;
        const rowHeight = 26;
        const height = Math.max(180, Math.max(sources.length, sinks.length) * rowHeight);
        const width = 720;
        const padTop = 22;
        const inner = height - padTop - 10;

        // Values become pixel heights on a shared scale, so both columns balance.
        const scale = (value) => (inputsTotal > 0 ? (value / inputsTotal) * (inner - GAP * Math.max(sources.length, sinks.length)) : 0);

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

        // Pour each input into the sinks in order; the overlap is one ribbon.
        const ribbons = [];
        const cursorL = left.map((n) => ({ node: n, used: 0 }));
        const cursorR = right.map((n) => ({ node: n, used: 0 }));
        let li = 0;
        let ri = 0;
        while (li < cursorL.length && ri < cursorR.length) {
            const source = cursorL[li];
            const sink = cursorR[ri];
            const remainingL = source.node.value - source.used;
            const remainingR = sink.node.value - sink.used;
            const moved = Math.min(remainingL, remainingR);

            if (moved > 0) {
                const h = Math.max(1, scale(moved));
                ribbons.push({
                    y0: source.node.y + scale(source.used),
                    y1: sink.node.y + scale(sink.used),
                    h,
                    color: sink.node.kind === 'fee' ? 'var(--red)' : typeColor(source.node.type),
                    title: `${amount(moved)} ${unitLabel()} → ${sink.node.label}`,
                });
                source.used += moved;
                sink.used += moved;
            }
            if (source.node.value - source.used <= 0) li += 1;
            if (sink.node.value - sink.used <= 0) ri += 1;
        }

        const ribbonPaths = ribbons.map((r) => {
            const x0 = NODE_W;
            const x1 = width - NODE_W;
            const mid = (x0 + x1) / 2;
            const d = `M${x0},${r.y0} C${mid},${r.y0} ${mid},${r.y1} ${x1},${r.y1} ` +
                      `L${x1},${r.y1 + r.h} C${mid},${r.y1 + r.h} ${mid},${r.y0 + r.h} ${x0},${r.y0 + r.h} Z`;
            return `<path class="ribbon" d="${d}" fill="${r.color}"><title>${esc(r.title)}</title></path>`;
        }).join('');

        const nodeRects = (nodes, anchorSide) => nodes.map((n) => {
            const textX = anchorSide === 'start' ? NODE_W + 8 : width - NODE_W - 8;
            const color = n.kind === 'fee' ? 'var(--red)' : typeColor(n.type);
            const showText = n.h >= 11;
            return `
                <rect x="${n.x}" y="${n.y}" width="${NODE_W}" height="${n.h}" rx="3" fill="${color}">
                    <title>${esc(n.label)} — ${esc(amount(n.value))} ${unitLabel()}</title>
                </rect>
                ${showText ? `<text class="node-value" x="${textX}" y="${n.y + n.h / 2 + 4}" text-anchor="${anchorSide}">${esc(amount(n.value))}</text>` : ''}`;
        }).join('');

        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('height', height);
        svg.innerHTML = `
            <text class="axis-title" x="0" y="12">Inputs — coins spent</text>
            <text class="axis-title" x="${width}" y="12" text-anchor="end">Outputs — coins created</text>
            ${ribbonPaths}
            ${nodeRects(left, 'start')}
            ${nodeRects(right, 'end')}`;
        svg.querySelectorAll('.ribbon').forEach((node, i) => node.style.setProperty('--i', i));
    }

    // ── Size composition ────────────────────────────────────────────────────
    /**
     * Splits the transaction's virtual bytes into fixed overhead, per-input and
     * per-output cost. The same weight model the builder uses, so the segments
     * add up to the reported vbyte total.
     */
    const INPUT_VB = {
        p2pkh: 148, p2sh: 148, 'p2sh-p2wpkh': 91, 'p2sh-p2wsh': 105,
        p2wpkh: 68, p2wsh: 105, p2tr: 58,
    };

    function renderSizeBreakdown(report) {
        const overhead = 11;
        const parts = [];

        const byInputType = {};
        report.selected_inputs.forEach((input) => {
            const vb = INPUT_VB[input.script_type] || 68;
            byInputType[input.script_type] = (byInputType[input.script_type] || 0) + vb;
        });

        const outputsVb = report.outputs.reduce(
            (sum, o) => sum + 9 + (o.script_pubkey_hex ? o.script_pubkey_hex.length / 2 : 22), 0);

        parts.push({ label: 'overhead', vb: overhead, color: '#6c7a94',
            note: 'version, counts and locktime — the fixed skeleton of any transaction' });
        Object.entries(byInputType).forEach(([type, vb]) => {
            parts.push({ label: `${type} inputs`, vb, color: typeColor(type),
                note: 'each input carries an outpoint, a signature and a sequence number' });
        });
        parts.push({ label: 'outputs', vb: outputsVb, color: 'var(--green)',
            note: 'each output is just an amount plus a locking script — far cheaper than an input' });

        const modelled = parts.reduce((sum, p) => sum + p.vb, 0);
        // Reconcile rounding against the authoritative figure from the builder.
        const scale = modelled > 0 ? report.vbytes / modelled : 1;

        el.sizeStack.innerHTML = parts.map((part) => {
            const pct = (part.vb / modelled) * 100;
            return `<div class="stack-seg" style="width:${pct}%; background:${part.color}"
                title="${esc(part.label)}: about ${Math.round(part.vb * scale)} vB">${pct > 11 ? `${Math.round(pct)}%` : ''}</div>`;
        }).join('');
        stagger(el.sizeStack);

        el.sizeKey.innerHTML = parts.map((part) => `
            <span title="${esc(part.note)}"><i class="swatch" style="background:${part.color}"></i>
            ${esc(part.label)}: <b>~${fmt(Math.round(part.vb * scale))} vB</b></span>`).join('');
    }

    // ── Wallet findings ─────────────────────────────────────────────────────
    /**
     * Wallet-level observations the report alone does not surface: privacy
     * leaks the transaction creates, and whether the remaining pool is heading
     * for trouble.
     */
    function walletFindings(report, fixture, change) {
        const findings = [];
        const pool = fixture && Array.isArray(fixture.utxos) ? fixture.utxos : [];
        const payments = report.outputs.filter((o) => !o.is_change);

        // Paying the same address twice links those payments publicly.
        const addresses = payments.map((o) => o.address).filter(Boolean);
        if (new Set(addresses).size < addresses.length) {
            findings.push({
                level: 'danger',
                title: 'The same address is paid more than once',
                text: 'Both payments land on one address, which publicly ties them together and to every other payment that address has ever received. Ask the recipient for a fresh address per payment.',
            });
        }

        // A round payment beside odd change makes the change obvious.
        if (change && payments.length === 1 && payments[0].value_sats % 1000 === 0 && change.value_sats % 1000 !== 0) {
            findings.push({
                level: 'warn',
                title: 'Your change output is easy to spot',
                text: `You are paying a round ${fmt(payments[0].value_sats)} sats and getting ${fmt(change.value_sats)} back. People pay round numbers; wallets compute change to the satoshi. Anyone watching can tell which output returned to you.`,
            });
        }

        // Spending several address types together proves one owner holds them all.
        const inputTypes = new Set(report.selected_inputs.map((i) => i.script_type));
        if (inputTypes.size > 1) {
            findings.push({
                level: 'note',
                title: 'Different address types spent together',
                text: `This spends ${inputTypes.size} address types at once. Every input has to be signed by its owner, so this proves a single wallet controls all of them.`,
            });
        }

        // A pool full of tiny coins gets expensive to spend later.
        const leftover = pool.filter((u) => !report.selected_inputs
            .some((i) => i.txid === u.txid && i.vout === u.vout));
        const uneconomic = leftover.filter((u) => (u.value_sats || 0) < 5000);
        if (uneconomic.length >= 3) {
            const rate = report.summary ? report.summary.target_fee_rate_sat_vb : report.fee_rate_sat_vb;
            const sweepCost = Math.ceil(uneconomic.length * 68 * rate);
            const sweepValue = uneconomic.reduce((sum, u) => sum + (u.value_sats || 0), 0);
            findings.push({
                level: sweepCost > sweepValue ? 'danger' : 'note',
                title: `${fmt(uneconomic.length)} small coins left in the wallet`,
                text: sweepCost > sweepValue
                    ? `Sweeping them at ${rate} sat/vB would cost about ${fmt(sweepCost)} sats in fees to recover ${fmt(sweepValue)} sats. They currently cost more to spend than they are worth — economically, they are already dust.`
                    : `Sweeping them at ${rate} sat/vB would cost roughly ${fmt(sweepCost)} sats to consolidate ${fmt(sweepValue)} sats. Worth doing while fees are low, because each one adds about 68 vB to any future payment.`,
            });
        }

        if (findings.length === 0) {
            findings.push({
                level: 'good',
                title: 'Nothing concerning in this build',
                text: 'No address reuse, no obvious change leak, and no pile of uneconomic coins left behind.',
            });
        }

        el.walletFindings.innerHTML = findings.map((f) => `
            <div class="finding ${esc(f.level)}">
                <b>${esc(f.title)}</b>
                <span>${esc(f.text)}</span>
            </div>`).join('');
        stagger(el.walletFindings);
    }

    // ── Fee-rate simulator ──────────────────────────────────────────────────
    /**
     * Rebuilds the same wallet situation at a different fee rate. This is the
     * clearest way to show that coin selection is a function of the fee market,
     * not a fixed answer.
     */
    let simTimer = null;

    /** Increments per request so a slow reply cannot overwrite a newer one. */
    let simRequest = 0;

    async function runSimulation(rate) {
        if (!lastFixture) return;
        const ticket = ++simRequest;
        const probe = { ...lastFixture, fee_rate_sat_vb: rate };

        let report;
        try {
            report = await (await fetch('/api/build', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(probe),
            })).json();
        } catch (err) {
            if (ticket === simRequest) {
                el.simGrid.innerHTML = '<div class="empty">Could not reach the builder.</div>';
            }
            return;
        }

        if (ticket !== simRequest) return;

        if (!report.ok) {
            el.simGrid.innerHTML = `
                <div class="sim-fail">
                    <b>${esc(report.error.code)}</b>
                    <span>At ${rate} sat/vB this payment can no longer be funded — ${esc(report.error.message)}</span>
                </div>`;
            return;
        }

        const baseline = lastReport;
        const changed = (a, b) => (a === b ? '' : ' sim-changed');
        const changeOut = report.change_index === null ? null : report.outputs[report.change_index];

        el.simGrid.innerHTML = `
            <div class="sim-cell${changed(report.fee_sats, baseline.fee_sats)}">
                <span class="sim-label">Fee</span>
                <b>${esc(amount(report.fee_sats))}</b>
                <span class="sim-sub">${unitLabel()}</span>
            </div>
            <div class="sim-cell${changed(report.selected_inputs.length, baseline.selected_inputs.length)}">
                <span class="sim-label">Coins spent</span>
                <b>${fmt(report.selected_inputs.length)}</b>
                <span class="sim-sub">was ${fmt(baseline.selected_inputs.length)}</span>
            </div>
            <div class="sim-cell${changed(report.vbytes, baseline.vbytes)}">
                <span class="sim-label">Size</span>
                <b>${fmt(report.vbytes)}</b>
                <span class="sim-sub">vB</span>
            </div>
            <div class="sim-cell${changed(!!changeOut, baseline.change_index !== null)}">
                <span class="sim-label">Change</span>
                <b>${changeOut ? esc(amount(changeOut.value_sats)) : 'none'}</b>
                <span class="sim-sub">${changeOut ? unitLabel() : 'folded into the fee'}</span>
            </div>`;
    }

    el.simSlider.addEventListener('input', () => {
        const rate = Number(el.simSlider.value);
        el.simRate.textContent = rate;
        // Debounced: the slider fires far faster than a rebuild round-trip.
        clearTimeout(simTimer);
        simTimer = setTimeout(() => runSimulation(rate), 130);
    });

    // ── PSBT decoding ───────────────────────────────────────────────────────
    /** Human names for the BIP-174 key types this builder emits. */
    const PSBT_KEYS = {
        global: {
            0x00: ['PSBT_GLOBAL_UNSIGNED_TX', 'The unsigned transaction itself, with every scriptSig left empty.'],
            0xfb: ['PSBT_GLOBAL_VERSION', 'Which version of the PSBT format this is.'],
        },
        input: {
            0x00: ['PSBT_IN_NON_WITNESS_UTXO', 'The whole previous transaction, proving what this input is worth.'],
            0x01: ['PSBT_IN_WITNESS_UTXO', 'Just the output being spent — amount and locking script.'],
            0x02: ['PSBT_IN_PARTIAL_SIG', 'A signature contributed by one signer.'],
            0x03: ['PSBT_IN_SIGHASH_TYPE', 'Which parts of the transaction the signature commits to.'],
            0x06: ['PSBT_IN_BIP32_DERIVATION', 'Where in the wallet tree this key lives.'],
            0x0e: ['PSBT_IN_TAP_KEY_SIG', 'A Taproot key-path signature.'],
        },
        output: {
            0x00: ['PSBT_OUT_REDEEM_SCRIPT', 'The script this P2SH output commits to.'],
            0x01: ['PSBT_OUT_WITNESS_SCRIPT', 'The script this P2WSH output commits to.'],
            0x02: ['PSBT_OUT_BIP32_DERIVATION', 'Where in the wallet tree this key lives.'],
        },
    };

    /**
     * Walks the PSBT's key-value maps: a global map, then one map per input and
     * one per output, each terminated by a zero-length key.
     */
    function decodePsbt(base64) {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        let at = 0;

        const magic = [...bytes.slice(0, 5)].map((b) => b.toString(16).padStart(2, '0')).join('');
        if (magic !== '70736274ff') throw new Error('not a PSBT: wrong magic bytes');
        at = 5;

        // BIP-174 lengths are Bitcoin compact size, not a base-128 varint.
        const compactSize = () => {
            const first = bytes[at];
            at += 1;
            if (first < 0xfd) return first;
            if (first === 0xfd) {
                const value = bytes[at] | (bytes[at + 1] << 8);
                at += 2;
                return value;
            }
            if (first === 0xfe) {
                const value = (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
                at += 4;
                return value;
            }
            // 8-byte form: lengths this large never appear in a real PSBT.
            at += 8;
            return 0;
        };
        const take = (n) => { const slice = bytes.slice(at, at + n); at += n; return slice; };
        const hex = (arr) => [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');

        const readMap = (scope, index) => {
            const records = [];
            while (at < bytes.length) {
                const keyLen = compactSize();
                if (keyLen === 0) break;
                const key = take(keyLen);
                const value = take(compactSize());
                const [name, note] = (PSBT_KEYS[scope] || {})[key[0]] || [`unknown key 0x${key[0].toString(16)}`, ''];
                records.push({ scope, index, name, note, keyHex: hex(key), valueHex: hex(value), bytes: value.length });
            }
            return records;
        };

        const records = readMap('global', null);

        // The map count is not stored: it comes from the unsigned transaction.
        const unsigned = records.find((r) => r.name === 'PSBT_GLOBAL_UNSIGNED_TX');
        const counts = unsigned ? countTxIo(unsigned.valueHex) : { inputs: 0, outputs: 0 };

        for (let i = 0; i < counts.inputs; i += 1) records.push(...readMap('input', i));
        for (let i = 0; i < counts.outputs; i += 1) records.push(...readMap('output', i));

        return { records, counts, totalBytes: bytes.length };
    }

    /** Counts inputs and outputs in a raw unsigned transaction. */
    function countTxIo(txHex) {
        const bytes = txHex.match(/../g).map((h) => parseInt(h, 16));
        let at = 4; // version

        const compact = () => {
            const first = bytes[at];
            at += 1;
            if (first < 0xfd) return first;
            if (first === 0xfd) { const v = bytes[at] | (bytes[at + 1] << 8); at += 2; return v; }
            if (first === 0xfe) { const v = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24); at += 4; return v >>> 0; }
            at += 8;
            return 0;
        };

        const inputs = compact();
        for (let i = 0; i < inputs; i += 1) {
            at += 36;
            at += compact();
            at += 4;
        }
        const outputs = compact();
        return { inputs, outputs };
    }

    function renderPsbt(report) {
        el.psbt.textContent = report.psbt_base64;

        let decoded;
        try {
            decoded = decodePsbt(report.psbt_base64);
        } catch (err) {
            el.psbtDecoded.innerHTML = `<div class="empty">Could not decode this PSBT — ${esc(err.message)}</div>`;
            return;
        }

        const intro = `
            <p class="hint">${fmt(decoded.totalBytes)} bytes: a global section describing the transaction, then one
            section per input and per output. Each entry is a key telling a signer what the value means. There are
            no signatures here — that is what makes it <i>partially signed</i>.</p>`;

        el.psbtDecoded.innerHTML = intro + decoded.records.map((record) => {
            const scopeLabel = record.index === null ? 'global' : `${record.scope} #${record.index}`;
            const preview = record.valueHex.length > 160
                ? `${record.valueHex.slice(0, 160)}…`
                : record.valueHex || '(empty)';
            return `
                <div class="record">
                    <div class="record-head">
                        <span class="record-scope ${esc(record.scope)}">${esc(scopeLabel)}</span>
                        <span class="record-name">${esc(record.name)}</span>
                        <span class="record-key">key 0x${esc(record.keyHex)} &middot; ${fmt(record.bytes)} B</span>
                    </div>
                    <div class="record-body">${esc(preview)}
                        ${record.note ? `<span class="record-note">${esc(record.note)}</span>` : ''}
                    </div>
                </div>`;
        }).join('');
        stagger(el.psbtDecoded, '.record');
    }

    el.psbtTabDecoded.addEventListener('click', () => {
        el.psbtTabDecoded.classList.add('active');
        el.psbtTabRaw.classList.remove('active');
        el.psbtDecoded.classList.remove('hidden');
        el.psbt.classList.add('hidden');
    });

    el.psbtTabRaw.addEventListener('click', () => {
        el.psbtTabRaw.classList.add('active');
        el.psbtTabDecoded.classList.remove('active');
        el.psbt.classList.remove('hidden');
        el.psbtDecoded.classList.add('hidden');
    });

    // ── Unit toggle ─────────────────────────────────────────────────────────
    function setUnit(next) {
        if (unit === next) return;
        unit = next;
        el.unitSats.classList.toggle('active', next === 'sats');
        el.unitBtc.classList.toggle('active', next === 'btc');
        document.querySelectorAll('.unit-word').forEach((node) => { node.textContent = unitLabel(); });
        if (lastReport) render(lastReport);
    }

    el.unitSats.addEventListener('click', () => setUnit('sats'));
    el.unitBtc.addEventListener('click', () => setUnit('btc'));

    // ── Startup ─────────────────────────────────────────────────────────────
    async function checkHealth() {
        try {
            const res = await fetch('/api/health');
            const data = await res.json();
            el.apiHealth.textContent = data.ok ? 'API healthy' : 'API error';
            el.apiHealth.className = `pill ${data.ok ? 'pill-ok' : 'pill-bad'}`;
        } catch (err) {
            el.apiHealth.textContent = 'API unreachable';
            el.apiHealth.className = 'pill pill-bad';
        }
    }

    loadFixtureList();
    checkHealth();
});
