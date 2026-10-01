# map_folder_full.md — the FULL structure of C:\Users\connessn\Observation_only\test-rig\work as one mermaid graph

Human AND machine readable: ONE node per folder and per file of the working
folder (label = the path relative to the working folder, "." = the working
folder, folders carry a "/" suffix), ONE edge per parent → child link.
It contains ALL folders and files — everything, not only the working folder —
and can be LARGE: do not read it whole, have a SUBAGENT read it and hand back
the paths of interest.

8 folder(s) mapped · 121 file(s) mapped

```mermaid
graph TD
  n0["."]
  n1["critic-f-run.cjs"]
  n0 --> n1
  n2["critic-long-run.cjs"]
  n0 --> n2
  n3["isolated-harness/"]
  n0 --> n3
  n4["mock-stderr.txt"]
  n0 --> n4
  n5["mock-stdout.txt"]
  n0 --> n5
  n6["patch.cjs"]
  n0 --> n6
  n7["piece3/"]
  n0 --> n7
  n8["probe-pump-script.json"]
  n0 --> n8
  n9["probe-readline.mjs"]
  n0 --> n9
  n10["probe-run2.mjs"]
  n0 --> n10
  n11["probe-tty-pump.mjs"]
  n0 --> n11
  n12["project-harness/"]
  n0 --> n12
  n13["pty-probe.cjs"]
  n0 --> n13
  n14["pump-a.bin"]
  n0 --> n14
  n15["pump-a.jsonl"]
  n0 --> n15
  n16["pump-trace.jsonl"]
  n0 --> n16
  n17["tool-mock.mjs"]
  n0 --> n17
  n18["tool-requests.log"]
  n0 --> n18
  n19["trace-one.mjs"]
  n0 --> n19
  n20["trace-script.json"]
  n0 --> n20
  n21["isolated-harness/models.json"]
  n3 --> n21
  n22["isolated-harness/sessions/"]
  n3 --> n22
  n23["isolated-harness/settings.json"]
  n3 --> n23
  n24["piece3/a-mouse-click.bin"]
  n7 --> n24
  n25["piece3/a-mouse-click.jsonl"]
  n7 --> n25
  n26["piece3/a-wheel.bin"]
  n7 --> n26
  n27["piece3/a-wheel.jsonl"]
  n7 --> n27
  n28["piece3/b-esc-interrupt.bin"]
  n7 --> n28
  n29["piece3/b-esc-interrupt.jsonl"]
  n7 --> n29
  n30["piece3/b2.bin"]
  n7 --> n30
  n31["piece3/b2.jsonl"]
  n7 --> n31
  n32["piece3/b3.bin"]
  n7 --> n32
  n33["piece3/b3.jsonl"]
  n7 --> n33
  n34["piece3/b3.probe.log"]
  n7 --> n34
  n35["piece3/b4.bin"]
  n7 --> n35
  n36["piece3/b4.jsonl"]
  n7 --> n36
  n37["piece3/b4.probe.log"]
  n7 --> n37
  n38["piece3/b5.bin"]
  n7 --> n38
  n39["piece3/b5.jsonl"]
  n7 --> n39
  n40["piece3/b5.probe.log"]
  n7 --> n40
  n41["piece3/b6.bin"]
  n7 --> n41
  n42["piece3/b6.jsonl"]
  n7 --> n42
  n43["piece3/b6.probe.log"]
  n7 --> n43
  n44["piece3/c-ctrlc-idle.bin"]
  n7 --> n44
  n45["piece3/c-ctrlc-idle.jsonl"]
  n7 --> n45
  n46["piece3/c-trace.bin"]
  n7 --> n46
  n47["piece3/c-trace.jsonl"]
  n7 --> n47
  n48["piece3/d-prologue-free.bin"]
  n7 --> n48
  n49["piece3/d-prologue-free.jsonl"]
  n7 --> n49
  n50["piece3/e-tool-preview.bin"]
  n7 --> n50
  n51["piece3/e-tool-preview.jsonl"]
  n7 --> n51
  n52["piece3/f-tool-truncate.bin"]
  n7 --> n52
  n53["piece3/f-tool-truncate.jsonl"]
  n7 --> n53
  n54["piece3/my-err.bin.jsonl"]
  n7 --> n54
  n55["piece3/my-err.json"]
  n7 --> n55
  n56["piece3/my-err2.bin"]
  n7 --> n56
  n57["piece3/my-err2.bin.jsonl"]
  n7 --> n57
  n58["piece3/my-f2.bin"]
  n7 --> n58
  n59["piece3/my-f2.jsonl"]
  n7 --> n59
  n60["piece3/my-long.bin"]
  n7 --> n60
  n61["piece3/my-long.jsonl"]
  n7 --> n61
  n62["piece3/my-long2.bin"]
  n7 --> n62
  n63["piece3/my-long2.bin.jsonl"]
  n7 --> n63
  n64["piece3/probe-pump.bin"]
  n7 --> n64
  n65["piece3/probe-pump.jsonl"]
  n7 --> n65
  n66["project-harness/big.txt"]
  n12 --> n66
  n67["project-harness/ten.txt"]
  n12 --> n67
  n68["isolated-harness/sessions/--C--Users-connessn-AppData-Local-Temp-crit_p3_proj--/"]
  n22 --> n68
  n69["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work--/"]
  n22 --> n69
  n70["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/"]
  n22 --> n70
  n71["isolated-harness/sessions/--C--Users-connessn-AppData-Local-Temp-crit_p3_proj--/2026-09-28T08-04-52-505Z_0fd367fb-f99d-492e-827f-23b390300530.jsonl"]
  n68 --> n71
  n72["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work--/2026-09-28T09-40-27-646Z_659dbbe2-aaae-4b43-9a2e-08ef9ffaeff4.jsonl"]
  n69 --> n72
  n73["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T06-57-17-969Z_53a46e0c-0b02-4336-ae74-f6a01ba28c8e.jsonl"]
  n70 --> n73
  n74["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-09-01-877Z_5fcd1b10-8931-44cd-84be-59a9997c6e0e.jsonl"]
  n70 --> n74
  n75["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-09-29-392Z_45d4dc16-f00c-41ee-868e-a444454ba50e.jsonl"]
  n70 --> n75
  n76["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-09-43-297Z_16dcbfaf-a2dc-4332-9307-f68169a41a03.jsonl"]
  n70 --> n76
  n77["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-11-10-170Z_b4f79e8e-a5e2-45a5-a19f-3ab35dfc430c.jsonl"]
  n70 --> n77
  n78["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-13-45-488Z_2beac5ed-d783-470e-894f-329930c30ee5.jsonl"]
  n70 --> n78
  n79["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-14-43-792Z_2a475cd2-24e0-489a-8af6-1061bbd5d176.jsonl"]
  n70 --> n79
  n80["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-20-48-973Z_1c764699-2c17-4f46-b07f-6e0a957e6a0a.jsonl"]
  n70 --> n80
  n81["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-21-16-278Z_3a883f26-1005-4673-976d-d076bf730ab8.jsonl"]
  n70 --> n81
  n82["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-21-30-167Z_b7d2c361-6dc2-4d53-b0fb-f32a1bfa7c3f.jsonl"]
  n70 --> n82
  n83["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-22-30-612Z_737bed62-9cdb-4716-bac5-d0f1f909341d.jsonl"]
  n70 --> n83
  n84["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-24-47-076Z_339dd0ff-3d31-4c71-a739-3991d030cc32.jsonl"]
  n70 --> n84
  n85["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-25-14-613Z_356e3729-f445-4d18-b4a1-01ca12464fa1.jsonl"]
  n70 --> n85
  n86["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-25-28-598Z_9f3c11b6-3392-462c-a5eb-a05fb4da93b5.jsonl"]
  n70 --> n86
  n87["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-29-55-484Z_1b89ae3e-7177-4c02-b222-ceebc1670593.jsonl"]
  n70 --> n87
  n88["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-30-09-512Z_dce75416-976b-46d2-8891-11352dd74772.jsonl"]
  n70 --> n88
  n89["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-39-21-975Z_afa35bb2-004c-4a85-a2a4-6c87a445c120.jsonl"]
  n70 --> n89
  n90["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-39-36-163Z_924014d4-faae-43da-a912-d3dab18d9def.jsonl"]
  n70 --> n90
  n91["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-41-46-081Z_d0b28589-6703-4878-94cd-e6b04a7b9e9c.jsonl"]
  n70 --> n91
  n92["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-42-00-092Z_9ccfd995-94d9-4a5f-89a7-72d3762544d1.jsonl"]
  n70 --> n92
  n93["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-45-04-315Z_eeaed4e5-80ab-4023-8575-3364da2a8332.jsonl"]
  n70 --> n93
  n94["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-45-18-416Z_2ad1514e-89e6-4756-940d-9a3273439d4a.jsonl"]
  n70 --> n94
  n95["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-46-07-936Z_85f53e09-e413-4057-aede-4ae3756da670.jsonl"]
  n70 --> n95
  n96["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-46-21-880Z_f16c8791-4005-40c5-8169-f0d7f4568175.jsonl"]
  n70 --> n96
  n97["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-46-53-286Z_e053c022-15e2-4bdc-b0df-eb74ea01d1cd.jsonl"]
  n70 --> n97
  n98["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-47-07-392Z_37d1a7c4-84fa-4cc1-b4ba-27b1dd43b6ab.jsonl"]
  n70 --> n98
  n99["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-51-58-379Z_63da5ac0-e1c5-487e-b762-39891ebb7827.jsonl"]
  n70 --> n99
  n100["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-52-03-966Z_cd3cb68f-b550-4d25-b7b8-81107c9b6d6c.jsonl"]
  n70 --> n100
  n101["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-53-51-519Z_71dff8a2-f97e-4bc8-ada7-87f3f88304f5.jsonl"]
  n70 --> n101
  n102["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T07-53-57-066Z_d2fc2998-0298-4308-9bfd-aa4ccd062488.jsonl"]
  n70 --> n102
  n103["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T08-06-20-356Z_403fde38-18ef-4c9e-8944-d2b52d654b5d.jsonl"]
  n70 --> n103
  n104["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T08-06-25-902Z_7cda93e6-e9ed-4e03-bea4-1a586a8b8f11.jsonl"]
  n70 --> n104
  n105["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T08-06-57-517Z_83b73dbf-eb26-46d9-b8ec-afa418fc8070.jsonl"]
  n70 --> n105
  n106["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T08-07-03-089Z_5bc4d8a7-e301-46ba-a0a5-e5c6d93bcfe5.jsonl"]
  n70 --> n106
  n107["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T08-11-49-819Z_297bc6d8-0093-4864-afcc-7944e037c1ee.jsonl"]
  n70 --> n107
  n108["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T08-11-55-421Z_2f30d5e0-cbb1-442e-a1da-daa3ac38a9b1.jsonl"]
  n70 --> n108
  n109["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T08-14-04-052Z_09e49e71-5dcf-40fc-b5e1-479eefe134e5.jsonl"]
  n70 --> n109
  n110["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T08-14-09-657Z_46a3ac73-6f07-4053-bbd7-6a16e88d2645.jsonl"]
  n70 --> n110
  n111["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T08-58-33-449Z_c95ff721-2790-42c2-92ed-7f69cd4ce2d3.jsonl"]
  n70 --> n111
  n112["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T08-58-38-837Z_ddb2faff-e3b5-4fb4-b681-48356bed2c50.jsonl"]
  n70 --> n112
  n113["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-00-17-686Z_d367aed5-a8c8-41f2-9628-bd1f44c28252.jsonl"]
  n70 --> n113
  n114["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-00-23-284Z_b34ce499-01c2-4746-ae67-b3b98d5ae66f.jsonl"]
  n70 --> n114
  n115["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-25-08-609Z_5fabe15d-c494-4977-bacd-50190bc3ee45.jsonl"]
  n70 --> n115
  n116["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-25-22-255Z_1787ad44-e0df-49bf-8342-fee82346a2e0.jsonl"]
  n70 --> n116
  n117["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-27-14-105Z_2e86a54f-7255-4351-82ed-6ae96766cd8e.jsonl"]
  n70 --> n117
  n118["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-27-19-206Z_f68f7b14-06ac-4873-8b36-db0bdc2a1a1c.jsonl"]
  n70 --> n118
  n119["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-30-04-759Z_951ad105-f477-46c6-9fac-8f9046a1a30c.jsonl"]
  n70 --> n119
  n120["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-30-33-732Z_38b82744-98eb-4d95-a09a-7528965956ef.jsonl"]
  n70 --> n120
  n121["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-30-38-791Z_cd075dc4-1ca5-4ba1-96ac-e6543b56a402.jsonl"]
  n70 --> n121
  n122["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-32-23-225Z_99940fa7-09f3-4be3-9ec8-ad9c7eb70f32.jsonl"]
  n70 --> n122
  n123["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-32-28-318Z_9af4bfeb-2f98-4a6c-8f1d-fd10ef74c25d.jsonl"]
  n70 --> n123
  n124["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-33-13-956Z_410e6a53-aee0-47ea-a245-248ad109b2c4.jsonl"]
  n70 --> n124
  n125["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-33-18-989Z_3a1870eb-2a06-4c03-91c2-5e81889389c7.jsonl"]
  n70 --> n125
  n126["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-35-33-909Z_e409fe64-e055-4643-959b-3ac6d22ad9df.jsonl"]
  n70 --> n126
  n127["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-35-38-999Z_da8e02b5-c500-4a2d-826a-de84ed9dfe96.jsonl"]
  n70 --> n127
  n128["isolated-harness/sessions/--C--Users-connessn-Observation_only-test-rig-work-project-harness--/2026-09-28T09-40-22-580Z_e3edcfe3-0fa9-406d-9297-c5a4331edda4.jsonl"]
  n70 --> n128
```
