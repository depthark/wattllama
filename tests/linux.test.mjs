// Linux platform code against a fake /proc and /sys tree.
import nodeTest from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as linux from "../platform/linux.mjs";

// Real Linux paths contain ":" (intel-rapl:0), which Windows cannot create: run on Linux only.
const test = process.platform === "linux" ? nodeTest : (name, ...rest) => nodeTest(name, { skip: "Linux only" }, rest.at(-1));

function fakeRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wattllama-sys-"));
  const write = (rel, content) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(content)); };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  return { root, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const BASE = {
  "etc/os-release": 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n',
  "proc/stat": "cpu  1000 0 1000 8000 0 0 0 0 0 0\ncpu0 1 1 1 1\n",
  "proc/diskstats": "   8       0 sda 100 0 2000 0 50 0 4000 0 0 0 0\n   8       1 sda1 100 0 2000 0 50 0 4000 0 0 0 0\n   7       0 loop0 1 0 999999 0 0 0 0 0 0 0 0\n",
  "sys/block/sda/size": "1", "sys/block/loop0/size": "1",
  "sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq": "3600000",
  "sys/devices/system/cpu/cpu1/cpufreq/scaling_cur_freq": "4000000",
  "sys/class/thermal/thermal_zone0/type": "acpitz\n", "sys/class/thermal/thermal_zone0/temp": "27800\n",
  "sys/class/powercap/intel-rapl:0/name": "package-0\n", "sys/class/powercap/intel-rapl:0/energy_uj": "1000000\n",
  "sys/class/powercap/intel-rapl:0/max_energy_range_uj": "262143328850\n",
  "sys/class/powercap/intel-rapl:0:0/name": "core\n", "sys/class/powercap/intel-rapl:0:0/energy_uj": "5\n",
  "sys/class/powercap/intel-rapl:0:2/name": "dram\n", "sys/class/powercap/intel-rapl:0:2/energy_uj": "100000\n",
  "sys/class/powercap/intel-rapl:0:2/max_energy_range_uj": "65532610987\n",
};

test("osName from /etc/os-release, sanitised", () => {
  const f = fakeRoot(BASE);
  try { assert.equal(linux.osName(f.root), "Ubuntu 24.04.1 LTS"); } finally { f.cleanup(); }
});

test("RAPL zones: packages and dram, not core", () => {
  const f = fakeRoot(BASE);
  try { assert.deepEqual(linux.raplZones(f.root).map((z) => z.kind).sort(), ["dram", "pkg"]); } finally { f.cleanup(); }
});

test("CPU sampler: load, clock, RAPL watts, disk bytes, ACPI zone", async () => {
  const f = fakeRoot(BASE);
  const got = [];
  const timer = linux.startCpuSampler({ intervalMs: 200, root: f.root, onSample: (s) => got.push(s) });
  try {
    // 1 s later in counter terms: +20 J package, +2 J dram over ~0.2 s wall time
    f.write("proc/stat", "cpu  1500 0 1500 9000 0 0 0 0 0 0\n");          // 1000 busy of 2000 -> 50 %
    f.write("sys/class/powercap/intel-rapl:0/energy_uj", "21000000\n");
    f.write("sys/class/powercap/intel-rapl:0:2/energy_uj", "2100000\n");
    f.write("proc/diskstats", "   8       0 sda 100 0 4000 0 50 0 6000 0 0 0 0\n   7       0 loop0 1 0 1999999 0 0 0 0 0 0 0 0\n");
    for (let i = 0; i < 30 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
    const s = got[0];
    assert.ok(s, "a sample arrived");
    assert.equal(Math.round(s.util), 50);
    assert.equal(s.mhz, 3800);
    assert.equal(s.zone, 27.8);
    assert.ok(s.pkg > 50 && s.pkg < 200, `package watts from energy delta (${s.pkg})`);
    assert.ok(Math.abs(s.dram / s.pkg - 0.1) < 0.001, "dram is a tenth of the package");
    assert.ok(s.diskR > 0 && Math.abs(s.diskR / s.diskW - 1) < 0.001, "only the whole disk, not loop0");
  } finally { clearInterval(timer); f.cleanup(); }
});

test("CPU sampler: unreadable RAPL (root only) gives null, the helper file is used when fresh", async () => {
  const f = fakeRoot({ ...BASE, "run/wattllama/rapl": `42.5 3.1 ${Math.floor(Date.now() / 1000)}\n` });
  fs.rmSync(path.join(f.root, "sys/class/powercap/intel-rapl:0/energy_uj"));       // like EACCES
  const got = [];
  const timer = linux.startCpuSampler({ intervalMs: 100, root: f.root, onSample: (s) => got.push(s) });
  try {
    for (let i = 0; i < 30 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(got[0].pkg, 42.5);
    assert.equal(got[0].dram, 3.1);
    f.write("run/wattllama/rapl", `42.5 3.1 ${Math.floor(Date.now() / 1000) - 60}\n`);   // stale: ignored
    const n = got.length;
    for (let i = 0; i < 30 && got.length === n; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(got.at(-1).pkg, null);
  } finally { clearInterval(timer); f.cleanup(); }
});

test("hwmon: CPU temperature, NVMe, fans, discrete AMD GPU; APU and NVIDIA skipped", async () => {
  const f = fakeRoot({
    "sys/class/hwmon/hwmon0/name": "coretemp\n",
    "sys/class/hwmon/hwmon0/temp1_input": "61000\n", "sys/class/hwmon/hwmon0/temp1_label": "Package id 0\n",
    "sys/class/hwmon/hwmon0/temp2_input": "58000\n", "sys/class/hwmon/hwmon0/temp2_label": "Core 0\n",
    "sys/class/hwmon/hwmon1/name": "nvme\n", "sys/class/hwmon/hwmon1/temp1_input": "41850\n", "sys/class/hwmon/hwmon1/temp1_label": "Composite\n",
    "sys/class/hwmon/hwmon2/name": "nct6798\n", "sys/class/hwmon/hwmon2/fan2_input": "812\n", "sys/class/hwmon/hwmon2/temp7_input": "-62000\n",
    "sys/class/hwmon/hwmon3/name": "amdgpu\n", "sys/class/hwmon/hwmon3/power1_average": "212000000\n",
    "sys/class/hwmon/hwmon3/temp1_input": "52000\n", "sys/class/hwmon/hwmon3/temp1_label": "edge\n",
    "sys/class/hwmon/hwmon3/fan1_input": "1450\n", "sys/class/hwmon/hwmon3/freq1_input": "2400000000\n",
    "sys/class/hwmon/hwmon3/device/mem_info_vram_total": String(16 * 1024 ** 3), "sys/class/hwmon/hwmon3/device/mem_info_vram_used": String(9 * 1024 ** 3),
    "sys/class/hwmon/hwmon3/device/gpu_busy_percent": "97\n", "sys/class/hwmon/hwmon3/device/product_name": "AMD Radeon RX 7800 XT\n",
    "sys/class/hwmon/hwmon4/name": "amdgpu\n", "sys/class/hwmon/hwmon4/power1_average": "9000000\n",
    "sys/class/hwmon/hwmon4/device/mem_info_vram_total": String(512 * 1024 ** 2),
    "sys/class/hwmon/hwmon5/name": "nouveau\n", "sys/class/hwmon/hwmon5/temp1_input": "50000\n",
  });
  try {
    const r = await linux.readSensors(f.root);
    assert.equal(r.cpuTemp, 61);
    assert.deepEqual(r.gpus.map((g) => [g.name, g.power, g.util, g.vramUsed, g.temp, g.clockSm, g.index]),
      [["AMD Radeon RX 7800 XT", 212, 97, 9216, 52, 2400, "amdgpu0"]]);
    const names = r.groups.map((g) => g.hardware);
    assert.deepEqual(names, ["CPU (Intel)", "NVMe SSD", "nct6798", "AMD Radeon RX 7800 XT"]);   // the APU has no sensors
    assert.ok(!r.groups.find((g) => g.hardware === "nct6798").sensors.some((s) => s.kind === "temperature"), "-62 °C is a dead sensor");
    const again = await linux.readSensors(f.root);
    assert.equal(again.gpus[0].index, "amdgpu0", "stable index across reads");
  } finally { f.cleanup(); }
});

test("power limit command: no shell, numbers as separate arguments", () => {
  assert.deepEqual(linux.powerLimitCommand(0, 150), ["pkexec", ["nvidia-smi", "-i", "0", "-pl", "150"]]);
});
