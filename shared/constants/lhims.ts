/**
 * Speaking to LHIMS the way its own middleware does.
 *
 * The LHIMS client is a Java program that sits beside an analyser, reads its
 * results over TCP/IP or RS-232, and posts each one to the LHIMS server as a
 * plain HTTP call:
 *
 *   GET {BLIS_URL}api/update_result.php
 *       ?username=…&password=…&specimen_id=…&measure_id=…&result=…&dec=…
 *
 * answering "1" when the result was stored. That is the whole of its upload
 * path, and knowing it changes what is possible here in two ways.
 *
 * FIRST, SECHLIMS can carry an analyser to LHIMS itself. The client handles one
 * analyser per running instance — its settings are a single global PORT,
 * EQUIPMENT_IP and MODE — which is why this laboratory's second haematology
 * analyser and both chemistry analysers reach LHIMS through nothing at all.
 * SECHLIMS already receives them; posting them onward is the same HTTP call the
 * client would have made, so LHIMS gains three analysers without a line of the
 * middleware changing.
 *
 * SECOND, `measure_id` is not an invention: it is the `listestid` from the
 * laboratory's own LHIMS client configuration files, the number LHIMS knows a
 * parameter by. Those maps are reproduced below, per analyser, exactly as they
 * are written in the configs — so a result posted from SECHLIMS lands in the
 * same LHIMS field the middleware would have put it in, rather than in a
 * plausible-looking wrong one.
 *
 * The codes on the left are what each analyser actually puts on the wire. The
 * haematology analysers mostly emit Sysmex-style NUMERIC dictionary codes; the
 * chemistry analysers emit mnemonics. Both are kept as the configuration has
 * them rather than tidied into one style, because the point of these maps is to
 * match the machine, not to look consistent.
 */

export interface LhimsMeasure { measureId: number; label: string }

export interface LhimsMeasureMap {
  key: string;
  label: string;
  vendor: string;
  /** The LHIMS client configuration file this map was taken from. */
  sourceConfig: string;
  /** What the analyser sends → what LHIMS calls it. */
  measures: Record<string, LhimsMeasure>;
}

export const LHIMS_MEASURE_MAPS: LhimsMeasureMap[] = [
  {
    key: "sysmex_xs500i",
    label: "Sysmex XS-500i / XN series",
    vendor: "Sysmex",
    sourceConfig: "SYSMEXXS500i.xml",
    measures: {
      "1": { measureId: 1, label: "WBC" },
      "2": { measureId: 2, label: "RBC" },
      "3": { measureId: 3, label: "HGB" },
      "4": { measureId: 4, label: "HCT" },
      "5": { measureId: 5, label: "MCV" },
      "6": { measureId: 6, label: "MCH" },
      "7": { measureId: 7, label: "MCHC" },
      "8": { measureId: 8, label: "PLT" },
      "9": { measureId: 15, label: "NEUT%" },
      "10": { measureId: 16, label: "LYMPH%" },
      "11": { measureId: 17, label: "MONO%" },
      "12": { measureId: 18, label: "EO%" },
      "13": { measureId: 19, label: "BASO%" },
      "14": { measureId: 660, label: "NEUT#" },
      "15": { measureId: 661, label: "LYMPH#" },
      "16": { measureId: 662, label: "MONO#" },
      "17": { measureId: 663, label: "EO#" },
      "18": { measureId: 664, label: "BASO#" },
      "19": { measureId: 9, label: "RDW-SD" },
      "20": { measureId: 10, label: "RDW-CV" },
      "21": { measureId: 11, label: "PDW" },
      "22": { measureId: 12, label: "MPV" },
      "23": { measureId: 13, label: "P-LCR" },
      "24": { measureId: 14, label: "PCT" },
    },
  },
  {
    key: "sysmex_xt2000i",
    label: "Sysmex XT-1800i / XT-2000i",
    vendor: "Sysmex",
    sourceConfig: "SYSMEXXT2000i.xml",
    measures: {
      "WBC": { measureId: 541, label: "WBC" },
      "RBC": { measureId: 542, label: "RBC" },
      "HGB": { measureId: 543, label: "HGB" },
      "HCT": { measureId: 544, label: "HCT" },
      "MCV": { measureId: 545, label: "MCV" },
      "MCH": { measureId: 546, label: "MCH" },
      "MCHC": { measureId: 547, label: "MCHC" },
      "PLT": { measureId: 548, label: "PLT" },
      "NEUT%": { measureId: 556, label: "NEUT%" },
      "LYMPH%": { measureId: 558, label: "LYMPH%" },
      "MONO%": { measureId: 560, label: "MONO%" },
      "EO%": { measureId: 562, label: "EO%" },
      "BASO%": { measureId: 564, label: "BASO%" },
      "NEUT#": { measureId: 555, label: "NEUT#" },
      "LYMPH#": { measureId: 557, label: "LYMPH#" },
      "MONO#": { measureId: 559, label: "MONO#" },
      "EO#": { measureId: 561, label: "EO#" },
      "BASO#": { measureId: 563, label: "BASO#" },
      "RDW-SD": { measureId: 549, label: "RDW-SD" },
      "RDW-CV": { measureId: 550, label: "RDW-CV" },
      "PDW": { measureId: 551, label: "PDW" },
      "MPV": { measureId: 552, label: "MPV" },
      "P-LCR": { measureId: 553, label: "P-LCR" },
      "PCT": { measureId: 554, label: "PCT" },
      "RET#": { measureId: 565, label: "RET#" },
      "RET%": { measureId: 566, label: "RET%" },
    },
  },
  {
    key: "sysmex_kx21n",
    label: "Sysmex KX-21N",
    vendor: "Sysmex",
    sourceConfig: "SYSMEXKX21N.xml",
    measures: {
      "1": { measureId: 69, label: "WBC" },
      "2": { measureId: 70, label: "RBC" },
      "3": { measureId: 60, label: "HGB" },
      "4": { measureId: 71, label: "HCT" },
      "5": { measureId: 72, label: "MCV" },
      "6": { measureId: 73, label: "MCH" },
      "7": { measureId: 74, label: "MCHC" },
      "8": { measureId: 75, label: "PLT" },
      "9": { measureId: 79, label: "LYM%" },
      "10": { measureId: 329, label: "MXD%" },
      "11": { measureId: 78, label: "NEUT%" },
      "12": { measureId: 89, label: "LYM#" },
      "13": { measureId: 330, label: "MXD#" },
      "14": { measureId: 88, label: "NEUT#" },
      "15": { measureId: 332, label: "RDW-SD" },
      "16": { measureId: 333, label: "RDW-CV" },
      "17": { measureId: 76, label: "PDW" },
      "18": { measureId: 77, label: "MPV" },
      "19": { measureId: 331, label: "P-LCR" },
    },
  },
  {
    key: "mindray_bc3600",
    label: "Mindray BC-3600",
    vendor: "Mindray",
    sourceConfig: "mindraybc3600.xml",
    measures: {
      "13": { measureId: 41, label: "WBC" },
      "20": { measureId: 47, label: "RBC" },
      "21": { measureId: 48, label: "HGB" },
      "26": { measureId: 49, label: "HCT" },
      "23": { measureId: 50, label: "MCV" },
      "24": { measureId: 51, label: "MCH" },
      "22": { measureId: 52, label: "MCHC" },
      "25": { measureId: 53, label: "RDW-CV" },
      "31": { measureId: 490, label: "RDW-SD" },
      "27": { measureId: 54, label: "PLT" },
      "28": { measureId: 55, label: "MPV" },
      "29": { measureId: 491, label: "PDW" },
      "30": { measureId: 492, label: "PCT" },
      "14": { measureId: 476, label: "LYM#" },
      "15": { measureId: 486, label: "MID#" },
      "16": { measureId: 487, label: "GRAN#" },
      "17": { measureId: 43, label: "LYM%" },
      "18": { measureId: 488, label: "MID%" },
      "19": { measureId: 489, label: "GRAN%" },
    },
  },
  {
    key: "mindray_bc5300",
    label: "Mindray BC-5300",
    vendor: "Mindray",
    sourceConfig: "MindrayBC5300.xml",
    measures: {
      "WBC": { measureId: 1, label: "WBC" },
      "RBC": { measureId: 2, label: "RBC" },
      "HGB": { measureId: 3, label: "HGB" },
      "HCT": { measureId: 4, label: "HCT" },
      "MCV": { measureId: 5, label: "MCV" },
      "MCH": { measureId: 6, label: "MCH" },
      "MCHC": { measureId: 7, label: "MCHC" },
      "PLT": { measureId: 8, label: "PLT" },
      "PCT": { measureId: 9, label: "PCT" },
      "NEU%": { measureId: 254, label: "NEUT%" },
      "LYM%": { measureId: 224, label: "LYMPH%" },
      "MON%": { measureId: 222, label: "MONO%" },
      "EOS%": { measureId: 225, label: "EOS%" },
      "*ALY%": { measureId: 223, label: "ALY%" },
      "*ALY#": { measureId: 252, label: "ALY#" },
      "*LIC%": { measureId: 251, label: "LIC%" },
      "*LIC#": { measureId: 253, label: "LIC#" },
      "BAS%": { measureId: 226, label: "BASO%" },
      "NEU#": { measureId: 10, label: "NEUT#" },
      "LYM#": { measureId: 224, label: "LYMPH#" },
      "MON#": { measureId: 12, label: "MONO#" },
      "EOS#": { measureId: 13, label: "EO#" },
      "BAS#": { measureId: 14, label: "BASO#" },
      "RDW-SD": { measureId: 227, label: "RDW-SD" },
      "RDW-CV": { measureId: 228, label: "RDW-CV" },
      "PDW": { measureId: 229, label: "PDW" },
      "MPV": { measureId: 230, label: "MPV" },
      "P-LCR": { measureId: 231, label: "P-LCR" },
      "RET#": { measureId: 15, label: "RET#" },
      "RET%": { measureId: 16, label: "RET%" },
    },
  },
  {
    key: "mindray_bs380",
    label: "Mindray BS-380",
    vendor: "Mindray",
    sourceConfig: "MindrayBS380.xml",
    measures: {
      "WBC": { measureId: 1, label: "WBC" },
      "NEU": { measureId: 15, label: "NEU" },
      "LYM": { measureId: 17, label: "LYM" },
      "MONO": { measureId: 19, label: "MONO" },
      "EOS": { measureId: 21, label: "EOS" },
      "BASO": { measureId: 23, label: "BASO" },
      "RBC": { measureId: 2, label: "RBC" },
      "HGB": { measureId: 3, label: "HGB" },
      "HCT": { measureId: 4, label: "HCT" },
      "MCV": { measureId: 5, label: "MCV" },
      "MCH": { measureId: 6, label: "MCH" },
      "MCHC": { measureId: 7, label: "MCHC" },
      "RDW": { measureId: 262, label: "RDW" },
      "PLT": { measureId: 8, label: "PLT" },
      "MPV": { measureId: 264, label: "MPV" },
      "PCT": { measureId: 14, label: "PCT%" },
      "PDW": { measureId: 263, label: "PDW" },
      "%N": { measureId: 266, label: "NEU%" },
      "%L": { measureId: 267, label: "LYM%" },
      "%M": { measureId: 268, label: "MONO%" },
      "%E": { measureId: 269, label: "EO%" },
      "%B": { measureId: 270, label: "BASO%" },
    },
  },
  {
    key: "dirui_bf6800",
    label: "DIRUI BF-6800",
    vendor: "DIRUI",
    sourceConfig: "diruibf6800.xml",
    measures: {
      "6": { measureId: 34, label: "WBC" },
      "17": { measureId: 45, label: "RBC" },
      "18": { measureId: 33, label: "HGB" },
      "24": { measureId: 55, label: "PCT" },
      "19": { measureId: 50, label: "RDW-SD" },
      "20": { measureId: 51, label: "RDW-CV" },
      "21": { measureId: 52, label: "PDW" },
      "25": { measureId: 49, label: "PLT" },
      "13": { measureId: 40, label: "NEUT%" },
      "15": { measureId: 41, label: "LYMPH%" },
      "16": { measureId: 42, label: "MONO%" },
      "14": { measureId: 43, label: "EO%" },
      "12": { measureId: 44, label: "BASO%" },
      "8": { measureId: 35, label: "NEUT#" },
      "10": { measureId: 36, label: "LYMPH#" },
      "11": { measureId: 37, label: "MONO#" },
      "9": { measureId: 38, label: "EO#" },
      "7": { measureId: 39, label: "BASO#" },
      "22": { measureId: 53, label: "MPV" },
      "23": { measureId: 54, label: "P-LCR" },
    },
  },
  {
    key: "dirui_bcc3000b",
    label: "DIRUI BCC-3000B",
    vendor: "DIRUI",
    sourceConfig: "DIRUIBCC3000b.xml",
    measures: {
      "WBC": { measureId: 34, label: "WBC" },
      "RBC": { measureId: 45, label: "RBC" },
      "HGB": { measureId: 33, label: "HGB" },
      "HCT": { measureId: 46, label: "HCT" },
      "MCV": { measureId: 47, label: "MCV" },
      "MCH": { measureId: 6, label: "MCH" },
      "MCHC": { measureId: 48, label: "MCHC" },
      "GRA%": { measureId: 0, label: "GRA%" },
      "GRA#": { measureId: 0, label: "GRA#" },
      "PLT": { measureId: 49, label: "PLT" },
      "LYM%": { measureId: 41, label: "LYM%" },
      "MON%": { measureId: 42, label: "MON%" },
      "LYM#": { measureId: 36, label: "LYM#" },
      "MON#": { measureId: 37, label: "MON#" },
      "RDW-SD": { measureId: 50, label: "RDW-SD" },
      "RDW-CV": { measureId: 51, label: "RDW-CV" },
      "PDW": { measureId: 52, label: "PDW" },
      "MPV": { measureId: 53, label: "MPV" },
      "P-LCR": { measureId: 54, label: "P-LCR" },
      "PCT": { measureId: 55, label: "PCT" },
    },
  },
  {
    key: "celldyn_3700",
    label: "Abbott Cell-Dyn 3700",
    vendor: "Abbott",
    sourceConfig: "CELLDYN3700.xml",
    measures: {
      "WBC": { measureId: 1, label: "WBC" },
      "NEU": { measureId: 15, label: "NEU" },
      "LYM": { measureId: 17, label: "LYM" },
      "MONO": { measureId: 19, label: "MONO" },
      "EOS": { measureId: 21, label: "EOS" },
      "BASO": { measureId: 23, label: "BASO" },
      "RBC": { measureId: 2, label: "RBC" },
      "HGB": { measureId: 3, label: "HGB" },
      "HCT": { measureId: 4, label: "HCT" },
      "MCV": { measureId: 5, label: "MCV" },
      "MCH": { measureId: 6, label: "MCH" },
      "MCHC": { measureId: 7, label: "MCHC" },
      "RDW": { measureId: 262, label: "RDW" },
      "PLT": { measureId: 8, label: "PLT" },
      "MPV": { measureId: 264, label: "MPV" },
      "PCT": { measureId: 14, label: "PCT%" },
      "PDW": { measureId: 263, label: "PDW" },
      "%N": { measureId: 266, label: "NEU%" },
      "%L": { measureId: 267, label: "LYM%" },
      "%M": { measureId: 268, label: "MONO%" },
      "%E": { measureId: 269, label: "EO%" },
      "%B": { measureId: 270, label: "BASO%" },
    },
  },
  {
    key: "urit_3000plus",
    label: "URIT-3000 Plus",
    vendor: "URIT",
    sourceConfig: "urit3000plus.xml",
    measures: {
      "WBC": { measureId: 69, label: "WBC" },
      "RBC": { measureId: 70, label: "RBC" },
      "HGB": { measureId: 60, label: "HGB" },
      "HCT": { measureId: 71, label: "HCT" },
      "MCV": { measureId: 72, label: "MCV" },
      "MCH": { measureId: 73, label: "MCH" },
      "MCHC": { measureId: 74, label: "MCHC" },
      "MO%": { measureId: 17, label: "MONO%" },
      "MO#": { measureId: 662, label: "MONO%" },
      "PLT": { measureId: 75, label: "PLT" },
      "LY%": { measureId: 79, label: "LYM%" },
      "LY#": { measureId: 89, label: "LYM#" },
      "RDW_SD": { measureId: 332, label: "RDW-SD" },
      "RDW_CV": { measureId: 333, label: "RDW-CV" },
      "PDW": { measureId: 76, label: "PDW" },
      "MPV": { measureId: 77, label: "MPV" },
      "P_LCR": { measureId: 331, label: "P-LCR" },
      "P_LCC": { measureId: 0, label: "P-LCC" },
      "GR#": { measureId: 0, label: "GRAN#" },
      "GR%": { measureId: 0, label: "GRAN%" },
      "PCT": { measureId: 14, label: "PCT" },
    },
  },
  {
    key: "abx_micros60",
    label: "ABX Micros 60",
    vendor: "HORIBA",
    sourceConfig: "abxmicros60.xml",
    measures: {
      "!": { measureId: 272, label: "WBC" },
      "2": { measureId: 273, label: "RBC" },
      "3": { measureId: 274, label: "HGB" },
      "4": { measureId: 275, label: "HCT" },
      "5": { measureId: 278, label: "MCV" },
      "6": { measureId: 279, label: "MCH" },
      "7": { measureId: 280, label: "MCHC" },
      "8": { measureId: 281, label: "RDW" },
      "@": { measureId: 276, label: "PLT" },
      "A": { measureId: 282, label: "MPV" },
      "B": { measureId: 277, label: "THT" },
      "C": { measureId: 283, label: "PDW" },
      "#": { measureId: 284, label: "LYM%" },
      "%": { measureId: 285, label: "MON%" },
      "&quot;": { measureId: 287, label: "LYM#" },
      "$": { measureId: 288, label: "MON#" },
      "&amp;": { measureId: 289, label: "GRA#" },
      "&apos;": { measureId: 286, label: "GRA%" },
    },
  },
  {
    key: "abx_pentra80",
    label: "ABX Pentra 80",
    vendor: "HORIBA",
    sourceConfig: "abxpentra80.xml",
    measures: {
      "1": { measureId: 5, label: "WBC" },
      "12": { measureId: 2, label: "RBC" },
      "13": { measureId: 4, label: "HGB" },
      "14": { measureId: 4, label: "HCT" },
      "15": { measureId: 5, label: "MCV" },
      "16": { measureId: 6, label: "MCH" },
      "17": { measureId: 7, label: "MCHC" },
      "19": { measureId: 8, label: "PLT" },
      "7": { measureId: 15, label: "NEUT%" },
      "3": { measureId: 16, label: "LYMPH%" },
      "5": { measureId: 17, label: "MONO%" },
      "9": { measureId: 18, label: "EOS%" },
      "11": { measureId: 19, label: "BASO%" },
      "6": { measureId: 660, label: "NEUT#" },
      "2": { measureId: 661, label: "LYMPH#" },
      "4": { measureId: 662, label: "MONO#" },
      "8": { measureId: 663, label: "EO#" },
      "10": { measureId: 664, label: "BASO#" },
      "18": { measureId: 10, label: "RDW-CV" },
      "22": { measureId: 11, label: "PDW" },
      "20": { measureId: 12, label: "MPV" },
      "21": { measureId: 14, label: "PCT" },
    },
  },
  {
    key: "abx_pentra400",
    label: "ABX Pentra 400",
    vendor: "HORIBA",
    sourceConfig: "abxpentra400.xml",
    measures: {
      "1": { measureId: 5, label: "WBC" },
      "12": { measureId: 2, label: "RBC" },
      "13": { measureId: 4, label: "HGB" },
      "14": { measureId: 4, label: "HCT" },
      "15": { measureId: 5, label: "MCV" },
      "16": { measureId: 6, label: "MCH" },
      "17": { measureId: 7, label: "MCHC" },
      "19": { measureId: 8, label: "PLT" },
      "7": { measureId: 15, label: "NEUT%" },
      "3": { measureId: 16, label: "LYMPH%" },
      "5": { measureId: 17, label: "MONO%" },
      "9": { measureId: 18, label: "EOS%" },
      "11": { measureId: 19, label: "BASO%" },
      "6": { measureId: 660, label: "NEUT#" },
      "2": { measureId: 661, label: "LYMPH#" },
      "4": { measureId: 662, label: "MONO#" },
      "8": { measureId: 663, label: "EO#" },
      "10": { measureId: 664, label: "BASO#" },
      "18": { measureId: 10, label: "RDW-CV" },
      "22": { measureId: 11, label: "PDW" },
      "20": { measureId: 12, label: "MPV" },
      "21": { measureId: 14, label: "PCT" },
    },
  },
  {
    key: "selectra_pros",
    label: "ELITech Selectra Pro S",
    vendor: "ELITech",
    sourceConfig: "selectraProS.xml",
    measures: {
      "FBS": { measureId: 414, label: "GLUCOSE(FBS)" },
      "TP": { measureId: 156, label: "Total Protein" },
      "ALB": { measureId: 144, label: "Albumin" },
      "GB": { measureId: 154, label: "Globulin" },
      "TBIL": { measureId: 146, label: "Total Bilirubin" },
      "DBIL": { measureId: 148, label: "Direct Bilirubin" },
      "IBIL": { measureId: 150, label: "Indirect Bilirubin" },
      "AST": { measureId: 157, label: "AST" },
      "ALT": { measureId: 153, label: "ALT" },
      "GGT": { measureId: 159, label: "Gamma GT" },
      "ALP": { measureId: 152, label: "ALKALINE PHOS" },
      "UREA": { measureId: 164, label: "Urea(BUN)" },
      "CREA": { measureId: 167, label: "Creatinine" },
      "UA": { measureId: 101, label: "Uric Acid" },
      "CHOL": { measureId: 133, label: "Total Cholesterol" },
      "TRIG": { measureId: 141, label: "Triglycerides" },
      "HDL": { measureId: 137, label: "HDL Cholesterol" },
      "LDL": { measureId: 138, label: "LDL Cholesterol" },
      "GPSL": { measureId: 434, label: "GLUCOSE(RBS)" },
      "VLDL": { measureId: 139, label: "VLDL" },
      "CR": { measureId: 391, label: "CARDIAC INFARCT" },
      "CAL": { measureId: 97, label: "CALCIUM" },
      "AMYL": { measureId: 383, label: "AMYLASE" },
      "CK-M": { measureId: 123, label: "CK-MB" },
      "CK-N": { measureId: 476, label: "CK-NAC" },
      "LDH": { measureId: 158, label: "LDH" },
    },
  },
  {
    key: "selectra_junior",
    label: "ELITech Selectra Junior",
    vendor: "ELITech",
    sourceConfig: "selectrajunior.xml",
    measures: {
      "GLUC": { measureId: 37, label: "FBS (Glucose)" },
      "TP": { measureId: 525, label: "Total Protein" },
      "ALB": { measureId: 524, label: "Albumin" },
      "GLB": { measureId: 510, label: "Globulins" },
      "TBIL": { measureId: 532, label: "Total Bilirubin" },
      "DBIL": { measureId: 530, label: "Direct Bilirubin" },
      "IBIL": { measureId: 531, label: "Indirect Bilirubin" },
      "AST": { measureId: 526, label: "AST" },
      "ALT": { measureId: 527, label: "ALT" },
      "AMYL": { measureId: 500, label: "AMYLASE" },
      "GGT": { measureId: 529, label: "GGT" },
      "ALP": { measureId: 528, label: "ALKALINE PHOS" },
      "UREA": { measureId: 518, label: "Urea" },
      "CREA": { measureId: 519, label: "Creatinine" },
      "CK": { measureId: 502, label: "Creatinine Kinase" },
      "CALC": { measureId: 501, label: "CALCIUM" },
      "Na": { measureId: 515, label: "Sodium" },
      "K": { measureId: 516, label: "Potassium" },
      "UA": { measureId: 540, label: "Uric Acid" },
      "CHOL": { measureId: 523, label: "Total Cholesterol" },
      "TRIG": { measureId: 522, label: "Triglycerides" },
      "HDL": { measureId: 520, label: "HDL Cholesterol" },
      "LDL": { measureId: 521, label: "LDL Cholesterol" },
      "VLDL": { measureId: 774, label: "VLDL Cholesterol" },
      "CR": { measureId: 775, label: "Coronary Risk" },
      "LDH": { measureId: 159, label: "LDH" },
      "CK-M": { measureId: 505, label: "CK-MB" },
      "CI": { measureId: 517, label: "Chloride" },
    },
  },
  {
    key: "flexor_e",
    label: "ELITech Flexor E",
    vendor: "ELITech",
    sourceConfig: "flexore.xml",
    measures: {
      "GLUC": { measureId: 37, label: "FBS (Glucose)" },
      "TPRO": { measureId: 525, label: "Total Protein" },
      "ALB": { measureId: 524, label: "Albumin" },
      "GBL": { measureId: 510, label: "Globulins" },
      "TBIL": { measureId: 532, label: "Total Bilirubin" },
      "DBIL": { measureId: 530, label: "Direct Bilirubin" },
      "IBIL": { measureId: 531, label: "Indirect Bilirubin" },
      "AST": { measureId: 526, label: "AST" },
      "ALT": { measureId: 527, label: "ALT" },
      "AMYL": { measureId: 500, label: "AMYLASE" },
      "GGT": { measureId: 529, label: "GGT" },
      "ALP": { measureId: 528, label: "ALKALINE PHOS" },
      "UREA": { measureId: 518, label: "Urea" },
      "CREA": { measureId: 519, label: "Creatinine" },
      "CKNA": { measureId: 502, label: "Creatinine Kinase" },
      "CAL": { measureId: 501, label: "CALCIUM" },
      "Na": { measureId: 515, label: "Sodium" },
      "K": { measureId: 516, label: "Potassium" },
      "U/A": { measureId: 540, label: "Uric Acid" },
      "CHOL": { measureId: 523, label: "Total Cholesterol" },
      "TRIG": { measureId: 522, label: "Triglycerides" },
      "HDL": { measureId: 520, label: "HDL Cholesterol" },
      "LDL": { measureId: 521, label: "LDL Cholesterol" },
      "VLDL": { measureId: 774, label: "VLDL Cholesterol" },
      "CR": { measureId: 775, label: "Coronary Risk" },
      "LDH": { measureId: 159, label: "LDH" },
      "CKMB": { measureId: 505, label: "CK-MB" },
      "CI": { measureId: 517, label: "Chloride" },
    },
  },
  {
    key: "flexor_junior",
    label: "ELITech Flexor Junior",
    vendor: "ELITech",
    sourceConfig: "flexorjunior.xml",
    measures: {
      "GTT0": { measureId: 651, label: "Glucose (SI)" },
      "GTT1": { measureId: 428, label: "1HrPP" },
      "GTT2": { measureId: 429, label: "2HrPP" },
      "GTT3": { measureId: 670, label: "3HrPP" },
      "A/G": { measureId: 32, label: "A/G" },
      "A1c": { measureId: 204, label: "Hemoglobin A1c" },
      "AGAP": { measureId: 676, label: "Anion Gap" },
      "ALB": { measureId: 27, label: "ALBUMIN" },
      "ALB (SI)": { measureId: 28, label: "ALBUMIN (SI)" },
      "ALKP": { measureId: 677, label: "Alk Phos" },
      "AFP": { measureId: 600, label: "Alpha Fetoprotein" },
      "ALT": { measureId: 33, label: "ALT" },
      "AMYL": { measureId: 201, label: "AMYLASE" },
      "AST": { measureId: 34, label: "AST" },
      "B/C": { measureId: 645, label: "B/C" },
      "BUN": { measureId: 51, label: "BUN" },
      "BUN (SI)": { measureId: 646, label: "BUN(SI)" },
      "C/H": { measureId: 679, label: "CORONARY RISK" },
      "CA": { measureId: 205, label: "CALCIUM" },
      "CA (SI)": { measureId: 673, label: "CALCIUM (SI)" },
      "CHOL": { measureId: 89, label: "CHOLESTEROL" },
      "CHOL (SI)": { measureId: 92, label: "TOTAL CHOLESTEROL(SI)" },
      "CK-MB": { measureId: 598, label: "CK-MB" },
      "CL": { measureId: 39, label: "CHLORIDE" },
      "CLDL": { measureId: 680, label: "LDL-Calculated" },
      "CLDL (SI)": { measureId: 681, label: "LDL-Calculated (SI)" },
      "CO2": { measureId: 40, label: "CARBON DIOXIDE" },
      "CPK": { measureId: 43, label: "CPK" },
      "CRE": { measureId: 52, label: "CREATININE" },
      "CRE (SI)": { measureId: 647, label: "CREATININE(SI)" },
      "DBIL": { measureId: 649, label: "DIRECT BILIRUBIN" },
      "DBIL (SI)": { measureId: 650, label: "DIRECT BILIRUBIN (SI)" },
      "ESTR": { measureId: 297, label: "Estradiol" },
      "FSH": { measureId: 279, label: "FSH" },
      "FT3": { measureId: 595, label: "FT3" },
      "FT4": { measureId: 596, label: "FREE T4" },
      "GGT": { measureId: 431, label: "GGT" },
      "GLOB": { measureId: 678, label: "Globulin" },
      "GLU": { measureId: 36, label: "GLUCOSE" },
      "GLU (SI)": { measureId: 651, label: "GLUCOSE (SI)" },
      "hCG": { measureId: 597, label: "HCG (Serum)" },
      "HDL": { measureId: 682, label: "HDL" },
      "HDL (SI)": { measureId: 683, label: "HDL (SI)" },
      "IBIL": { measureId: 496, label: "INDIRECT BILIRUBIN" },
      "IBIL (SI)": { measureId: 648, label: "INDIRECT BILIRUBIN(SI)" },
      "IRON": { measureId: 684, label: "IRON" },
      "IRON (SI)": { measureId: 685, label: "IRON(SI)" },
      "K": { measureId: 38, label: "POTASSIUM" },
      "LDH": { measureId: 42, label: "LDH" },
      "LDL": { measureId: 686, label: "LDL-Direct" },
      "LH": { measureId: 687, label: "LH" },
      "MAG": { measureId: 202, label: "MAGNESIUM" },
      "MAG (SI)": { measureId: 208, label: "MAGNESIUM (SI)" },
      "NA": { measureId: 37, label: "SODIUM" },
      "PHOS": { measureId: 206, label: "Phosphorus" },
      "PHOS (SI)": { measureId: 674, label: "Phosphorus(SI)" },
      "PRO": { measureId: 26, label: "TOTAL PROTEIN" },
      "PRO (SI)": { measureId: 432, label: "TOTAL PROTEIN(SI)" },
      "PRL": { measureId: 289, label: "Prolactin" },
      "PROG": { measureId: 284, label: "Progesterone" },
      "PSA": { measureId: 302, label: "PSA" },
      "RBS": { measureId: 207, label: "RBS" },
      "T4": { measureId: 675, label: "T4" },
      "TBIL": { measureId: 494, label: "TOTAL BILIRUBIN" },
      "TBIL (SI)": { measureId: 495, label: "TOTAL BILIRUBIN (SI)" },
      "TESTO": { measureId: 291, label: "Testosterone" },
      "TRIG": { measureId: 90, label: "TRIGLYCERIDE" },
      "TRIG (SI)": { measureId: 652, label: "TRIGLYCERIDE (SI)" },
      "Troponin-I": { measureId: 599, label: "Troponin I" },
      "TSH": { measureId: 430, label: "TSH" },
      "VLDL": { measureId: 91, label: "VLDL" },
      "URIC": { measureId: 79, label: "URIC ACID" },
      "URIC (SI)": { measureId: 80, label: "URIC ACID(SI)" },
    },
  },
  {
    key: "bt3000_chameleon",
    label: "Biotecnica BT-3000 Plus (Chameleon)",
    vendor: "Biotecnica",
    sourceConfig: "bt3000pluschameleon.xml",
    measures: {
      "ALB(SI)": { measureId: 524, label: "ALBUMIN (SI)" },
      "ALP": { measureId: 528, label: "Alk Phos" },
      "ALT": { measureId: 527, label: "ALT" },
      "AMYL": { measureId: 500, label: "AMYLASE" },
      "AST": { measureId: 526, label: "AST" },
      "BUN(SI)": { measureId: 518, label: "BUN (SI)" },
      "CA(SI)": { measureId: 501, label: "CALCIUM (SI)" },
      "CHOL(SI)": { measureId: 523, label: "TOTAL CHOLESTEROL(SI)" },
      "CK-MB": { measureId: 505, label: "CK-MB" },
      "CL": { measureId: 517, label: "CHLORIDE" },
      "CO2": { measureId: 771, label: "CARBON DIOXIDE" },
      "CPK": { measureId: 502, label: "CPK" },
      "CRE(SI)": { measureId: 519, label: "CREATININE(SI)" },
      "DBIL(SI)": { measureId: 530, label: "DIRECT BILIRUBIN (SI)" },
      "GGT": { measureId: 529, label: "GGT" },
      "GLOB": { measureId: 510, label: "Globulin" },
      "GLU(SI)": { measureId: 508, label: "GLUCOSE (SI)" },
      "HDL(SI)": { measureId: 520, label: "HDL (SI)" },
      "IBIL(SI)": { measureId: 531, label: "INDIRECT BILIRUBIN(SI)" },
      "K": { measureId: 516, label: "POTASSIUM" },
      "LDH": { measureId: 503, label: "LDH" },
      "CLDL": { measureId: 521, label: "LDL-Direct" },
      "NA": { measureId: 515, label: "SODIUM" },
      "PHOS(SI)": { measureId: 772, label: "Phosphorus(SI)" },
      "PRO(SI)": { measureId: 525, label: "TOTAL PROTEIN(SI)" },
      "TBIL(SI)": { measureId: 532, label: "TOTAL BILIRUBIN (SI)" },
      "TRIG(SI)": { measureId: 522, label: "TRIGLYCERIDE (SI)" },
      "URIC(SI)": { measureId: 540, label: "URIC ACID(SI)" },
      "B12": { measureId: 773, label: "Vitamin B12" },
    },
  },
  {
    key: "vitros_350",
    label: "Ortho VITROS 350",
    vendor: "Ortho Clinical",
    sourceConfig: "vitros350.xml",
    measures: {
      "ALB": { measureId: 43, label: "ALBUMIN (SI)" },
      "ALKP": { measureId: 273, label: "Alk Phos" },
      "ALT": { measureId: 36, label: "ALT" },
      "AMYL": { measureId: 171, label: "AMYLASE" },
      "AST": { measureId: 35, label: "AST" },
      "UREA": { measureId: 30, label: "UREA" },
      "Ca": { measureId: 170, label: "CALCIUM (SI)" },
      "CHOL": { measureId: 312, label: "TOTAL CHOLESTEROL(SI)" },
      "CKMB": { measureId: 205, label: "CK-MB" },
      "Cl-": { measureId: 34, label: "CHLORIDE" },
      "ECO2": { measureId: 280, label: "CARBON DIOXIDE" },
      "CK": { measureId: 287, label: "CREATININE KINASE" },
      "CREA": { measureId: 31, label: "CREATININE(SI)" },
      "Bc": { measureId: 39, label: "DIRECT BILIRUBIN (SI)" },
      "Bu": { measureId: 291, label: "INDIRECT BILIRUBIN (SI)" },
      "dHDL": { measureId: 520, label: "DHDL (SI)" },
      "K+": { measureId: 33, label: "POTASSIUM" },
      "LDH": { measureId: 203, label: "LDH" },
      "CLDL": { measureId: 47, label: "LDL-Direct" },
      "Na+": { measureId: 32, label: "SODIUM" },
      "PHOS": { measureId: 772, label: "Phosphorus(SI)" },
      "TP": { measureId: 42, label: "TOTAL PROTEIN(SI)" },
      "TBIL": { measureId: 532, label: "TOTAL BILIRUBIN (SI)" },
      "TRIG": { measureId: 45, label: "TRIGLYCERIDE (SI)" },
      "URIC": { measureId: 52, label: "URIC ACID(SI)" },
      "B12": { measureId: 773, label: "Vitamin B12" },
      "Mg": { measureId: 773, label: "Magnesium" },
      "GLU": { measureId: 260, label: "Glucose (SI)" },
      "GGT": { measureId: 38, label: "GGT" },
      "LIPA": { measureId: 773, label: "LIPIDS" },
    },
  },
  {
    key: "genexpert",
    label: "Cepheid GeneXpert",
    vendor: "Cepheid",
    sourceConfig: "genexpert.xml",
    measures: {
      "59": { measureId: 59, label: "MTB" },
      "214": { measureId: 214, label: "RIF Resistance" },
    },
  },];

export function lhimsMapByKey(key?: string | null): LhimsMeasureMap | null {
  return LHIMS_MEASURE_MAPS.find(m => m.key === key) ?? null;
}

/**
 * The LHIMS measure id for a code this analyser sent.
 *
 * The link's own overrides win, then the shipped map for the analyser. An
 * unmapped code returns null and the result is NOT posted — LHIMS storing a
 * haemoglobin under whatever measure id happened to be nearby is far worse
 * than LHIMS not storing it, and the bench is told which codes are unmapped
 * so it can be fixed rather than guessed.
 */
export function lhimsMeasureId(
  code: string,
  overrides: Record<string, number> | null,
  mapKey?: string | null,
): number | null {
  const raw = String(code ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();

  if (overrides) {
    for (const [from, to] of Object.entries(overrides)) {
      if (String(from).toUpperCase() === upper) {
        const id = Number(to);
        return Number.isFinite(id) && id > 0 ? id : null;
      }
    }
  }
  const map = lhimsMapByKey(mapKey);
  if (map) {
    for (const [from, measure] of Object.entries(map.measures)) {
      if (from.toUpperCase() === upper) return measure.measureId;
    }
  }
  return null;
}

/* ============================================================================
   Where a copy of an existing transmission comes from
   ----------------------------------------------------------------------------
   The LHIMS client has a setting, WRITE_TO_FILE, that makes it append every
   message it receives — verbatim, before it does anything else with it — to a
   file called LHIMSDataInput.txt beside the program. It is the client's own
   feature, meant for troubleshooting.

   That file is how SECHLIMS gets a copy of the analyser LHIMS already owns
   without going anywhere near the link. Nothing is intercepted, no port is
   bound, no connection is opened to the analyser: SECHLIMS follows a file the
   middleware is already writing, read-only, the way `tail -f` does. If SECHLIMS
   is switched off, stops, or crashes, the LHIMS transmission does not notice.

   This is the only mechanism here that touches an analyser LHIMS owns, and it
   touches it not at all.
   ========================================================================= */

/** What the LHIMS client calls its append log, beside the .jar. */
export const LHIMS_TAP_FILENAME = 'LHIMSDataInput.txt';

export const LHIMS_TAP_SETUP_STEPS = [
  'On the PC running the LHIMS client, open its configuration and set WRITE_TO_FILE = Yes.',
  'Restart the LHIMS client. It will begin appending every message it receives to LHIMSDataInput.txt, beside the program.',
  'Share that folder read-only over the network, or point SECHLIMS at the file directly if it runs on the same machine.',
  'Add a link here in "Follow the LHIMS client\'s log" mode and give it the path to that file.',
];

/**
 * How much of the file to re-read when a link first starts.
 *
 * Starting at the end is right: the point is to follow what happens from now
 * on, and reading a year of history on first connection would flood the bench
 * with controls that were dealt with months ago.
 */
export const LHIMS_TAP_START_AT_END = true;

/** How often to look for new bytes. The file is local or on a share; this is cheap. */
export const LHIMS_TAP_POLL_MS = 3_000;

/* ============================================================================
   Delivering to LHIMS
   ========================================================================= */
export const LHIMS_DELIVERY_STATUSES = ['not_required', 'pending', 'sent', 'partial', 'failed'] as const;
export type LhimsDeliveryStatus = (typeof LHIMS_DELIVERY_STATUSES)[number];

export const LHIMS_DELIVERY_STATUS_LABELS: Record<LhimsDeliveryStatus, string> = {
  not_required: 'Not sent on — this link does not carry to LHIMS',
  pending: 'Waiting to be sent to LHIMS',
  sent: 'Delivered to LHIMS',
  partial: 'Partly delivered — some parameters were not mapped or were refused',
  failed: 'Could not be delivered',
};

/** LHIMS answers "1" when a result was stored. Anything else is a refusal. */
export function lhimsAccepted(response: string): boolean {
  return String(response ?? '').trim() === '1';
}

/** How many times to retry one message before it needs a person. */
export const LHIMS_MAX_ATTEMPTS = 5;

/**
 * Build the upload URL, exactly as the LHIMS client builds it.
 *
 * Kept in one place, and shaped from the decompiled client rather than from
 * guesswork, so a change to how LHIMS is addressed happens once.
 */
export function lhimsResultUrl(base: string, credentials: { username: string; password: string }, result: {
  specimenId: string; measureId: number; value: string; decimals?: number;
}): string {
  const root = String(base ?? '').trim().replace(/\/+$/, '') + '/';
  const q = (v: string) => encodeURIComponent(String(v ?? ''));
  return `${root}api/update_result.php`
    + `?username=${q(credentials.username)}&password=${q(credentials.password)}`
    + `&specimen_id=${q(result.specimenId)}`
    + `&measure_id=${Number(result.measureId)}`
    + `&result=${q(result.value)}`
    + `&dec=${Number(result.decimals ?? 0)}`;
}

/** The same URL with the password blanked, for logs, errors and the screen. */
export function lhimsSafeUrl(url: string): string {
  return url.replace(/([?&]password=)[^&]*/i, '$1•••');
}
