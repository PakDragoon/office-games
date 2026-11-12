// Thulla slap: Kaalu the cat or Moti the hippo pops up and smacks.
// Full screen for the player who picks up the trick (the palm slams flat on the glass);
// a mini version beside that player's seat for everyone else.
// Artwork and motion match the approved Round 5 design. Generated from the design canvas.

const ART = {"cat": {"svg": "<svg class=\"critter-svg\" viewBox=\"0 0 300 340\" role=\"img\" aria-label=\"Grey cat, slapping\"> <defs> <radialGradient id=\"kEye\" cx=\"40%\" cy=\"35%\" r=\"70%\"><stop offset=\"0\" stop-color=\"#fff2a0\"></stop><stop offset=\"0.55\" stop-color=\"#ffc233\"></stop><stop offset=\"1\" stop-color=\"#d9800f\"></stop></radialGradient> <radialGradient id=\"kBell\" cx=\"35%\" cy=\"30%\" r=\"70%\"><stop offset=\"0\" stop-color=\"#fff3b8\"></stop><stop offset=\"0.5\" stop-color=\"#f4c430\"></stop><stop offset=\"1\" stop-color=\"#b8860b\"></stop></radialGradient> </defs> <g stroke-linecap=\"round\" stroke-linejoin=\"round\"> <g data-o=\"impact\" fill=\"none\" stroke=\"#1b1e3a\" stroke-width=\"4\"> <path d=\"M58 44 l-18 -14 M48 76 l-24 -2 M76 22 l-8 -20\"></path> <path d=\"M84 40 l6 -16 l6 14 l14 -6 l-6 14 l14 6 l-14 6 l6 14 l-14 -6 l-6 14 l-6 -14 l-14 6 l6 -14 l-14 -6 l14 -6 l-6 -14 Z\" fill=\"#ffd24d\" stroke-width=\"3\"></path> </g> <g data-a=\"root\"><g data-a=\"lean\"> <path d=\"M224 300 C 282 298 296 238 264 210 C 256 204 247 212 253 219 C 276 244 264 280 222 282 Z\" fill=\"#4a4d57\" stroke=\"#15161b\" stroke-width=\"5\"></path> <path d=\"M262 224 C 268 232 270 242 270 250 L 262 248 C 262 240 260 232 256 226 Z M266 262 C 264 270 260 276 254 280 L 250 274 C 256 270 258 266 260 260 Z\" fill=\"#2c2e35\"></path> <path d=\"M58 340 C 38 300 50 236 96 214 C 118 204 182 204 204 214 C 250 236 262 300 242 340 Z\" fill=\"#4a4d57\" stroke=\"#15161b\" stroke-width=\"6\"></path> <path d=\"M204 214 C 250 236 262 300 242 340 L 204 340 C 226 300 224 252 198 222 Z\" fill=\"#33353d\"></path> <path d=\"M74 262 C 80 240 92 226 108 218 C 98 236 90 254 88 276 Z\" fill=\"#6b6f7c\" opacity=\"0.7\"></path> <path d=\"M62 290 C 72 286 82 288 88 294 C 80 295 72 298 64 302 Z M60 266 C 70 262 80 264 86 270 C 78 271 70 274 62 278 Z M238 290 C 228 286 218 288 212 294 C 220 295 228 298 236 302 Z M240 266 C 230 262 220 264 214 270 C 222 271 230 274 238 278 Z\" fill=\"#2c2e35\"></path> <path d=\"M104 206 L196 206 C 200 240 190 266 178 274 L 170 264 L 162 278 L 152 266 L 144 278 L 136 266 L 128 276 L 122 266 C 110 260 100 238 104 206 Z\" fill=\"#8c90a0\" stroke=\"#15161b\" stroke-width=\"2.5\"></path> <path d=\"M128 236 l4 8 M150 242 l0 9 M170 236 l-4 8 M140 252 l2 6 M160 252 l-2 6\" fill=\"none\" stroke=\"#5f6371\" stroke-width=\"2.2\"></path> <path d=\"M76 340 C 72 318 86 306 104 306 C 122 306 132 318 128 340 Z\" fill=\"#4a4d57\" stroke=\"#15161b\" stroke-width=\"5\"></path> <path d=\"M92 324 v14 M104 322 v16 M116 324 v14\" fill=\"none\" stroke=\"#15161b\" stroke-width=\"2.5\"></path> <path d=\"M172 340 C 168 318 180 306 196 306 C 214 306 226 318 222 340 Z\" fill=\"#4a4d57\" stroke=\"#15161b\" stroke-width=\"5\"></path> <path d=\"M186 324 v14 M198 322 v16 M210 324 v14\" fill=\"none\" stroke=\"#15161b\" stroke-width=\"2.5\"></path> <path d=\"M86 116 L34 70 C 50 62 80 66 112 84 Z\" fill=\"#4a4d57\" stroke=\"#15161b\" stroke-width=\"5\"></path> <path d=\"M84 104 L48 76 C 62 72 82 76 100 88 Z\" fill=\"#b9848f\"></path> <path d=\"M84 104 L66 90 C 74 88 86 90 96 96 Z\" fill=\"#8f5f6a\"></path> <path d=\"M60 82 l12 2 M66 90 l10 0\" fill=\"none\" stroke=\"#d6d8e0\" stroke-width=\"2\"></path> <path d=\"M214 116 L266 70 C 250 62 220 66 188 84 Z\" fill=\"#4a4d57\" stroke=\"#15161b\" stroke-width=\"5\"></path> <path d=\"M216 104 L252 76 C 238 72 218 76 200 88 Z\" fill=\"#b9848f\"></path> <path d=\"M216 104 L234 90 C 226 88 214 90 204 96 Z\" fill=\"#8f5f6a\"></path> <path d=\"M240 82 l-12 2 M234 90 l-10 0\" fill=\"none\" stroke=\"#d6d8e0\" stroke-width=\"2\"></path> <path d=\"M150 66 C 204 66 236 96 238 138 C 240 146 250 150 246 158 C 240 158 242 166 236 168 C 240 174 234 180 228 178 C 214 204 186 216 150 216 C 114 216 86 204 72 178 C 66 180 60 174 64 168 C 58 166 60 158 54 158 C 50 150 60 146 62 138 C 64 96 96 66 150 66 Z\" fill=\"#4a4d57\" stroke=\"#15161b\" stroke-width=\"6\"></path> <path d=\"M78 184 C 104 210 196 210 222 184 C 206 212 94 212 78 184 Z\" fill=\"#33353d\"></path> <path d=\"M228 150 C 232 132 226 108 210 92 C 222 110 224 132 220 152 Z\" fill=\"#33353d\"></path> <ellipse cx=\"122\" cy=\"92\" rx=\"30\" ry=\"11\" fill=\"#6b6f7c\" opacity=\"0.65\" transform=\"rotate(-14 122 92)\"></ellipse> <path d=\"M150 72 C 147 82 147 92 150 104 C 153 92 153 82 150 72 Z M130 76 C 132 86 134 94 140 102 C 138 92 136 84 130 76 Z M170 76 C 168 86 166 94 160 102 C 162 92 164 84 170 76 Z\" fill=\"#26282e\"></path> <path d=\"M62 140 C 72 138 82 140 90 146 C 80 146 70 148 62 150 Z M66 158 C 74 156 82 158 88 162 C 80 162 72 164 66 166 Z M238 140 C 228 138 218 140 210 146 C 220 146 230 148 238 150 Z M234 158 C 226 156 218 158 212 162 C 220 162 228 164 234 166 Z\" fill=\"#26282e\"></path> <g data-o=\"eyesOpen\"> <path d=\"M96 134 C 102 120 124 116 136 130 C 128 144 106 146 96 134 Z\" fill=\"url(#kEye)\" stroke=\"#15161b\" stroke-width=\"3.5\"></path> <path d=\"M204 134 C 198 120 176 116 164 130 C 172 144 194 146 204 134 Z\" fill=\"url(#kEye)\" stroke=\"#15161b\" stroke-width=\"3.5\"></path> <ellipse cx=\"117\" cy=\"132\" rx=\"2.6\" ry=\"9\" fill=\"#15161b\"></ellipse> <ellipse cx=\"183\" cy=\"132\" rx=\"2.6\" ry=\"9\" fill=\"#15161b\"></ellipse> <circle cx=\"111\" cy=\"127\" r=\"2.6\" fill=\"#ffffff\"></circle> <circle cx=\"177\" cy=\"127\" r=\"2.6\" fill=\"#ffffff\"></circle> <path d=\"M92 118 L140 128 L138 134 C 124 126 108 124 94 128 Z\" fill=\"#26282e\" stroke=\"#15161b\" stroke-width=\"2.5\"></path> <path d=\"M208 118 L160 128 L162 134 C 176 126 192 124 206 128 Z\" fill=\"#26282e\" stroke=\"#15161b\" stroke-width=\"2.5\"></path> </g> <g data-o=\"eyesShut\" fill=\"none\" stroke=\"#15161b\" stroke-width=\"5\"> <path d=\"M96 124 L132 134 L100 142\"></path> <path d=\"M204 124 L168 134 L200 142\"></path> </g> <path d=\"M150 160 C 140 148 112 148 110 166 C 108 182 132 188 150 178 C 168 188 192 182 190 166 C 188 148 160 148 150 160 Z\" fill=\"#8c90a0\" stroke=\"#15161b\" stroke-width=\"2.5\"></path> <g fill=\"#4a4d57\"><circle cx=\"124\" cy=\"164\" r=\"1.8\"></circle><circle cx=\"132\" cy=\"170\" r=\"1.8\"></circle><circle cx=\"120\" cy=\"172\" r=\"1.8\"></circle><circle cx=\"176\" cy=\"164\" r=\"1.8\"></circle><circle cx=\"168\" cy=\"170\" r=\"1.8\"></circle><circle cx=\"180\" cy=\"172\" r=\"1.8\"></circle></g> <path d=\"M140 150 C 144 146 156 146 160 150 C 158 158 154 161 150 162 C 146 161 142 158 140 150 Z\" fill=\"#d68897\" stroke=\"#15161b\" stroke-width=\"2.5\"></path> <ellipse cx=\"146\" cy=\"150.5\" rx=\"3\" ry=\"1.5\" fill=\"#f6c6cf\"></ellipse> <g data-o=\"smirk\"> <path d=\"M150 162 v6 C 144 176 134 176 128 170 M150 168 C 156 174 168 174 174 164\" fill=\"none\" stroke=\"#15161b\" stroke-width=\"3\"></path> <path d=\"M164 172 l3 8 l3 -7 Z\" fill=\"#f4f1ea\" stroke=\"#15161b\" stroke-width=\"1.8\"></path> </g> <g data-o=\"hiss\"> <path d=\"M126 170 C 132 164 144 166 150 170 C 156 166 168 164 174 170 C 172 196 128 196 126 170 Z\" fill=\"#5a1422\" stroke=\"#15161b\" stroke-width=\"3\"></path> <path d=\"M136 184 C 142 180 158 180 164 184 C 160 192 140 192 136 184 Z\" fill=\"#d97a8b\"></path> <path d=\"M131 171 l4 10 l4 -9 Z M169 171 l-4 10 l-4 -9 Z M136 190 l3 -7 l3 7 Z M164 190 l-3 -7 l-3 7 Z\" fill=\"#f4f1ea\" stroke=\"#15161b\" stroke-width=\"1.6\"></path> </g> <g fill=\"none\" stroke-linecap=\"round\"> <path d=\"M112 166 C 90 160 64 158 36 160 M112 172 C 88 172 62 176 38 184 M114 178 C 94 184 74 192 54 204\" stroke=\"#15161b\" stroke-width=\"3.6\"></path> <path d=\"M112 166 C 90 160 64 158 36 160 M112 172 C 88 172 62 176 38 184 M114 178 C 94 184 74 192 54 204\" stroke=\"#eef0f6\" stroke-width=\"1.6\"></path> <path d=\"M188 166 C 210 160 236 158 264 160 M188 172 C 212 172 238 176 262 184 M186 178 C 206 184 226 192 246 204\" stroke=\"#15161b\" stroke-width=\"3.6\"></path> <path d=\"M188 166 C 210 160 236 158 264 160 M188 172 C 212 172 238 176 262 184 M186 178 C 206 184 226 192 246 204\" stroke=\"#eef0f6\" stroke-width=\"1.6\"></path> </g> <path d=\"M94 204 C 120 222 180 222 206 204 L 204 216 C 180 234 120 234 96 216 Z\" fill=\"#c8263f\" stroke=\"#15161b\" stroke-width=\"3\"></path> <path d=\"M100 210 C 122 224 178 224 200 210\" fill=\"none\" stroke=\"#e8566b\" stroke-width=\"2\"></path> <circle cx=\"150\" cy=\"234\" r=\"11\" fill=\"url(#kBell)\" stroke=\"#15161b\" stroke-width=\"3\"></circle> <path d=\"M145 238 h10 M150 238 v5\" fill=\"none\" stroke=\"#15161b\" stroke-width=\"2\"></path> <g data-o=\"swoosh\" fill=\"none\" stroke=\"#9aa0bd\" stroke-width=\"5\"> <path d=\"M262 150 C 290 180 290 222 268 248\"></path><path d=\"M246 136 C 270 170 272 206 258 232\" stroke-width=\"3\"></path> </g> <g data-a=\"arm\" data-base=\"translate(206 236)\"> <path d=\"M-25 8 C -28 -30 -21 -64 -16 -86 L 16 -86 C 21 -64 28 -30 25 8 Z\" fill=\"#4a4d57\" stroke=\"#15161b\" stroke-width=\"5\"></path> <path d=\"M25 8 C 28 -30 21 -64 16 -86 L 8 -86 C 13 -62 18 -30 13 8 Z\" fill=\"#33353d\"></path> <path d=\"M-22 -26 C -12 -24 -4 -26 4 -32 C -6 -34 -16 -32 -22 -26 Z M-19 -52 C -10 -50 -2 -52 6 -58 C -4 -60 -14 -58 -19 -52 Z\" fill=\"#26282e\"></path> <g data-a=\"paw\" data-base=\"translate(0 -104)\"> <g data-o=\"backOp\"> <path d=\"M-27 16 C -32 4 -31 -10 -26 -17 C -27 -31 -13 -34 -12 -22 C -13 -37 1 -38 0 -24 C -1 -38 13 -37 12 -22 C 13 -34 27 -31 26 -17 C 31 -10 32 4 27 16 C 20 30 -20 30 -27 16 Z\" fill=\"#4a4d57\" stroke=\"#15161b\" stroke-width=\"5\"></path> <path d=\"M27 16 C 20 30 -20 30 -27 16 C -14 22 14 22 27 16 Z M26 -17 C 31 -10 32 4 27 16 C 24 4 23 -8 20 -14 Z\" fill=\"#33353d\"></path> <path d=\"M-12 -22 C -12 -15 -11 -10 -10 -6 M0 -24 C 0 -17 0 -11 0 -7 M12 -22 C 12 -15 11 -10 10 -6\" fill=\"none\" stroke=\"#15161b\" stroke-width=\"2.4\"></path> <path d=\"M-22 -6 q5 -4 10 0 M-5 -9 q5 -4 10 0 M12 -6 q5 -4 10 0\" fill=\"none\" stroke=\"#2a2c33\" stroke-width=\"2.4\"></path> <path d=\"M-14 6 C -8 2 -2 4 2 10 C -4 9 -10 9 -14 6 Z M4 4 C 10 0 16 2 20 8 C 14 7 8 7 4 4 Z\" fill=\"#26282e\"></path> <ellipse cx=\"-12\" cy=\"-26\" rx=\"7\" ry=\"3\" fill=\"#6b6f7c\" opacity=\"0.6\" transform=\"rotate(-15 -12 -26)\"></ellipse> </g> <g data-o=\"palmOp\"> <path d=\"M-27 16 C -32 4 -31 -10 -26 -17 C -27 -31 -13 -34 -12 -22 C -13 -37 1 -38 0 -24 C -1 -38 13 -37 12 -22 C 13 -34 27 -31 26 -17 C 31 -10 32 4 27 16 C 20 30 -20 30 -27 16 Z\" fill=\"#4a4d57\" stroke=\"#15161b\" stroke-width=\"5\"></path> <path d=\"M27 16 C 20 30 -20 30 -27 16 C -14 22 14 22 27 16 Z\" fill=\"#33353d\"></path> <path d=\"M-12 -22 C -12 -16 -11 -12 -9 -9 M0 -24 C 0 -18 0 -13 0 -10 M12 -22 C 12 -16 11 -12 9 -9\" fill=\"none\" stroke=\"#15161b\" stroke-width=\"2.2\"></path> <path d=\"M0 -4 C 10 -4 17 3 15 11 C 13 17 6 18 0 14 C -6 18 -13 17 -15 11 C -17 3 -10 -4 0 -4 Z\" fill=\"#d39aa6\" stroke=\"#8a5d68\" stroke-width=\"1.8\"></path> <ellipse cx=\"-4\" cy=\"2\" rx=\"4\" ry=\"2\" fill=\"#f2c9d1\"></ellipse> <ellipse cx=\"-19\" cy=\"-20\" rx=\"4.6\" ry=\"5.4\" fill=\"#d39aa6\" stroke=\"#8a5d68\" stroke-width=\"1.4\" transform=\"rotate(-20 -19 -20)\"></ellipse> <ellipse cx=\"-6\" cy=\"-27\" rx=\"4.6\" ry=\"5.8\" fill=\"#d39aa6\" stroke=\"#8a5d68\" stroke-width=\"1.4\"></ellipse> <ellipse cx=\"6\" cy=\"-27\" rx=\"4.6\" ry=\"5.8\" fill=\"#d39aa6\" stroke=\"#8a5d68\" stroke-width=\"1.4\"></ellipse> <ellipse cx=\"19\" cy=\"-20\" rx=\"4.6\" ry=\"5.4\" fill=\"#d39aa6\" stroke=\"#8a5d68\" stroke-width=\"1.4\" transform=\"rotate(20 19 -20)\"></ellipse> <g data-o=\"impact\" fill=\"#f4f1ea\" stroke=\"#15161b\" stroke-width=\"1.6\"> <path d=\"M-21 -30 C -24 -38 -22 -43 -18 -45 C -19 -40 -18 -35 -16 -31 Z\"></path> <path d=\"M-7 -37 C -9 -45 -6 -50 -2 -51 C -4 -46 -3 -41 -2 -37 Z\"></path> <path d=\"M7 -37 C 9 -45 6 -50 2 -51 C 4 -46 3 -41 2 -37 Z\"></path> <path d=\"M21 -30 C 24 -38 22 -43 18 -45 C 19 -40 18 -35 16 -31 Z\"></path> </g> </g> </g> </g> </g> </g> </g> </svg>", "palm": "<svg viewBox=\"-42 -56 84 90\" aria-hidden=\"true\"> <g stroke-linecap=\"round\" stroke-linejoin=\"round\"> <path d=\"M-27 16 C -32 4 -31 -10 -26 -17 C -27 -31 -13 -34 -12 -22 C -13 -37 1 -38 0 -24 C -1 -38 13 -37 12 -22 C 13 -34 27 -31 26 -17 C 31 -10 32 4 27 16 C 20 30 -20 30 -27 16 Z\" fill=\"#4a4d57\" stroke=\"#15161b\" stroke-width=\"5\"></path> <path d=\"M27 16 C 20 30 -20 30 -27 16 C -14 22 14 22 27 16 Z\" fill=\"#33353d\"></path> <path d=\"M-12 -22 C -12 -16 -11 -12 -9 -9 M0 -24 C 0 -18 0 -13 0 -10 M12 -22 C 12 -16 11 -12 9 -9\" fill=\"none\" stroke=\"#15161b\" stroke-width=\"2.2\"></path> <path d=\"M0 -4 C 10 -4 17 3 15 11 C 13 17 6 18 0 14 C -6 18 -13 17 -15 11 C -17 3 -10 -4 0 -4 Z\" fill=\"#d39aa6\" stroke=\"#8a5d68\" stroke-width=\"1.8\"></path> <ellipse cx=\"-4\" cy=\"2\" rx=\"4\" ry=\"2\" fill=\"#f2c9d1\"></ellipse> <ellipse cx=\"-19\" cy=\"-20\" rx=\"4.6\" ry=\"5.4\" fill=\"#d39aa6\" stroke=\"#8a5d68\" stroke-width=\"1.4\" transform=\"rotate(-20 -19 -20)\"></ellipse> <ellipse cx=\"-6\" cy=\"-27\" rx=\"4.6\" ry=\"5.8\" fill=\"#d39aa6\" stroke=\"#8a5d68\" stroke-width=\"1.4\"></ellipse> <ellipse cx=\"6\" cy=\"-27\" rx=\"4.6\" ry=\"5.8\" fill=\"#d39aa6\" stroke=\"#8a5d68\" stroke-width=\"1.4\"></ellipse> <ellipse cx=\"19\" cy=\"-20\" rx=\"4.6\" ry=\"5.4\" fill=\"#d39aa6\" stroke=\"#8a5d68\" stroke-width=\"1.4\" transform=\"rotate(20 19 -20)\"></ellipse> <g opacity=\"1\" fill=\"#f4f1ea\" stroke=\"#15161b\" stroke-width=\"1.6\"> <path d=\"M-21 -30 C -24 -38 -22 -43 -18 -45 C -19 -40 -18 -35 -16 -31 Z\"></path> <path d=\"M-7 -37 C -9 -45 -6 -50 -2 -51 C -4 -46 -3 -41 -2 -37 Z\"></path> <path d=\"M7 -37 C 9 -45 6 -50 2 -51 C 4 -46 3 -41 2 -37 Z\"></path> <path d=\"M21 -30 C 24 -38 22 -43 18 -45 C 19 -40 18 -35 16 -31 Z\"></path> </g> </g> </svg>", "print": "<svg viewBox=\"0 0 200 200\" aria-hidden=\"true\"> <g fill=\"#f4a3b8\" stroke=\"#1b1e3a\" stroke-width=\"6\" opacity=\"0.92\"> <path d=\"M100 92 c34 0 58 34 50 58 c-6 20 -28 22 -50 22 c-22 0 -44 -2 -50 -22 c-8 -24 16 -58 50 -58 z\"></path> <ellipse cx=\"44\" cy=\"80\" rx=\"18\" ry=\"24\" transform=\"rotate(-20 44 80)\"></ellipse> <ellipse cx=\"80\" cy=\"44\" rx=\"18\" ry=\"25\" transform=\"rotate(-6 80 44)\"></ellipse> <ellipse cx=\"122\" cy=\"44\" rx=\"18\" ry=\"25\" transform=\"rotate(6 122 44)\"></ellipse> <ellipse cx=\"158\" cy=\"80\" rx=\"18\" ry=\"24\" transform=\"rotate(20 158 80)\"></ellipse> </g> </svg>"}, "hippo": {"svg": "<svg class=\"critter-svg\" viewBox=\"0 0 300 340\" role=\"img\" aria-label=\"Angry hippo, slapping\"> <defs> <linearGradient id=\"hMuz\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0\" stop-color=\"#9d8d93\"></stop><stop offset=\"0.5\" stop-color=\"#bf9b9f\"></stop><stop offset=\"1\" stop-color=\"#d7a6a8\"></stop></linearGradient> </defs> <g stroke-linecap=\"round\" stroke-linejoin=\"round\"> <g data-o=\"impact\" fill=\"none\" stroke=\"#1b1e3a\" stroke-width=\"4\"> <path d=\"M58 44 l-18 -14 M48 76 l-24 -2 M76 22 l-8 -20\"></path> <path d=\"M84 40 l6 -16 l6 14 l14 -6 l-6 14 l14 6 l-14 6 l6 14 l-14 -6 l-6 14 l-6 -14 l-14 6 l6 -14 l-14 -6 l14 -6 l-6 -14 Z\" fill=\"#ffd24d\" stroke-width=\"3\"></path> </g> <g data-a=\"root\"><g data-a=\"lean\"> <path d=\"M36 340 C 22 288 42 232 92 216 C 122 208 178 208 208 216 C 258 232 278 288 264 340 Z\" fill=\"#8f7f85\" stroke=\"#1d1517\" stroke-width=\"6\"></path> <path d=\"M208 216 C 258 232 278 288 264 340 L 226 340 C 244 296 240 252 204 224 Z\" fill=\"#6c5e63\"></path> <path d=\"M60 270 C 66 248 80 234 98 226 C 88 246 80 264 78 286 Z\" fill=\"#ad9ea4\" opacity=\"0.8\"></path> <path d=\"M100 340 C 96 302 120 284 150 284 C 180 284 204 302 200 340 Z\" fill=\"#c99a9c\"></path> <path d=\"M70 244 q10 -6 20 -2 M66 258 q10 -5 18 -2 M230 244 q-10 -6 -20 -2\" fill=\"none\" stroke=\"#5a4d52\" stroke-width=\"2.5\"></path> <path d=\"M60 340 L 62 306 C 64 292 110 292 112 306 L 114 340 Z\" fill=\"#8f7f85\" stroke=\"#1d1517\" stroke-width=\"5\"></path> <path d=\"M70 340 C 70 330 82 330 82 340 Z M82 340 C 82 330 94 330 94 340 Z M94 340 C 94 330 106 330 106 340 Z\" fill=\"#efe4d6\" stroke=\"#1d1517\" stroke-width=\"2.5\"></path> <path d=\"M94 80 C 76 64 70 46 82 40 C 96 36 108 56 110 74 Z\" fill=\"#8f7f85\" stroke=\"#1d1517\" stroke-width=\"5\"></path> <path d=\"M96 72 C 86 62 82 52 88 48 C 96 48 102 60 104 70 Z\" fill=\"#d79aa0\"></path> <path d=\"M206 80 C 224 64 230 46 218 40 C 204 36 192 56 190 74 Z\" fill=\"#8f7f85\" stroke=\"#1d1517\" stroke-width=\"5\"></path> <path d=\"M204 72 C 214 62 218 52 212 48 C 204 48 198 60 196 70 Z\" fill=\"#d79aa0\"></path> <path d=\"M84 98 C 80 66 104 54 120 66 C 134 58 166 58 180 66 C 196 54 220 66 216 98 C 218 118 212 134 204 142 L 96 142 C 88 134 82 118 84 98 Z\" fill=\"#8f7f85\" stroke=\"#1d1517\" stroke-width=\"6\"></path> <ellipse cx=\"124\" cy=\"70\" rx=\"22\" ry=\"8\" fill=\"#ad9ea4\" opacity=\"0.8\" transform=\"rotate(-10 124 70)\"></ellipse> <path d=\"M130 82 q20 -6 40 0 M134 92 q16 -5 32 0 M150 98 v10\" fill=\"none\" stroke=\"#5a4d52\" stroke-width=\"2.5\"></path> <g fill=\"none\" stroke=\"#e0283e\" stroke-width=\"4\"> <path d=\"M190 52 q7 5 0 11 M206 52 q-7 5 0 11 M192 49 q6 7 12 0 M192 66 q6 -7 12 0\"></path> </g> <g data-o=\"eyesOpen\"> <path d=\"M92 96 C 96 86 112 84 118 94 C 112 104 98 104 92 96 Z\" fill=\"#fff1ef\" stroke=\"#1d1517\" stroke-width=\"3\"></path> <circle cx=\"108\" cy=\"96\" r=\"4.4\" fill=\"#1d1517\"></circle> <circle cx=\"109.5\" cy=\"94.5\" r=\"1.5\" fill=\"#ffffff\"></circle> <path d=\"M94 97 l4 1 M95 100 l4 -1\" fill=\"none\" stroke=\"#e0283e\" stroke-width=\"1.3\"></path> <path d=\"M208 96 C 204 86 188 84 182 94 C 188 104 202 104 208 96 Z\" fill=\"#fff1ef\" stroke=\"#1d1517\" stroke-width=\"3\"></path> <circle cx=\"192\" cy=\"96\" r=\"4.4\" fill=\"#1d1517\"></circle> <circle cx=\"193.5\" cy=\"94.5\" r=\"1.5\" fill=\"#ffffff\"></circle> <path d=\"M206 97 l-4 1 M205 100 l-4 -1\" fill=\"none\" stroke=\"#e0283e\" stroke-width=\"1.3\"></path> </g> <g data-o=\"eyesShut\" fill=\"none\" stroke=\"#1d1517\" stroke-width=\"5\"> <path d=\"M92 88 L116 96 L94 104\"></path><path d=\"M208 88 L184 96 L206 104\"></path> </g> <path d=\"M84 80 L126 94 L122 102 C 110 94 96 90 86 92 Z\" fill=\"#5d4f54\" stroke=\"#1d1517\" stroke-width=\"3\"></path> <path d=\"M216 80 L174 94 L178 102 C 190 94 204 90 214 92 Z\" fill=\"#5d4f54\" stroke=\"#1d1517\" stroke-width=\"3\"></path> <g data-o=\"jawOpen\"> <path d=\"M58 196 C 62 304 238 304 242 196 Z\" fill=\"#8f7f85\" stroke=\"#1d1517\" stroke-width=\"6\"></path> <path d=\"M74 204 C 84 286 216 286 226 204 C 196 216 104 216 74 204 Z\" fill=\"#6e1f2c\" stroke=\"#1d1517\" stroke-width=\"3\"></path> <path d=\"M110 264 C 120 246 180 246 190 264 C 178 280 122 280 110 264 Z\" fill=\"#d9788a\"></path> <path d=\"M150 252 v18\" fill=\"none\" stroke=\"#b3566a\" stroke-width=\"2\"></path> <path d=\"M84 250 C 78 228 84 208 94 194 C 98 212 100 232 100 252 Z\" fill=\"#f3ead8\" stroke=\"#1d1517\" stroke-width=\"3\"></path> <path d=\"M216 250 C 222 228 216 208 206 194 C 202 212 200 232 200 252 Z\" fill=\"#f3ead8\" stroke=\"#1d1517\" stroke-width=\"3\"></path> <path d=\"M88 236 q4 -2 8 0 M212 236 q-4 -2 -8 0\" fill=\"none\" stroke=\"#c9bba3\" stroke-width=\"2\"></path> <path d=\"M132 262 l5 -13 l5 13 Z M158 262 l5 -13 l5 13 Z\" fill=\"#f3ead8\" stroke=\"#1d1517\" stroke-width=\"2\"></path> </g> <g data-o=\"jawShut\"> <path d=\"M150 118 C 216 112 254 142 254 184 C 254 226 210 248 150 248 C 90 248 46 226 46 184 C 46 142 84 112 150 118 Z\" fill=\"url(#hMuz)\" stroke=\"#1d1517\" stroke-width=\"6\"></path> <path d=\"M58 212 C 86 244 214 244 242 212 C 230 240 192 250 150 250 C 108 250 70 240 58 212 Z\" fill=\"#b9878a\"></path> <path d=\"M62 214 C 100 230 200 230 238 214\" fill=\"none\" stroke=\"#1d1517\" stroke-width=\"5\"></path> <path d=\"M88 232 C 84 214 88 200 96 190 C 100 204 102 218 102 234 Z\" fill=\"#f3ead8\" stroke=\"#1d1517\" stroke-width=\"3\"></path> <path d=\"M212 232 C 216 214 212 200 204 190 C 200 204 198 218 198 234 Z\" fill=\"#f3ead8\" stroke=\"#1d1517\" stroke-width=\"3\"></path> </g> <g data-o=\"jawOpen\"> <path d=\"M150 116 C 214 110 252 138 252 172 C 252 200 222 214 196 212 C 180 210 120 210 104 212 C 78 214 48 200 48 172 C 48 138 86 110 150 116 Z\" fill=\"url(#hMuz)\" stroke=\"#1d1517\" stroke-width=\"6\"></path> <path d=\"M124 210 l4 11 l4 -11 Z M168 210 l4 11 l4 -11 Z\" fill=\"#f3ead8\" stroke=\"#1d1517\" stroke-width=\"2\"></path> </g> <ellipse cx=\"150\" cy=\"128\" rx=\"44\" ry=\"8\" fill=\"#b3a4aa\" opacity=\"0.7\"></ellipse> <path d=\"M110 136 C 102 126 118 118 128 128 C 130 138 120 144 110 136 Z\" fill=\"#3a2228\" stroke=\"#1d1517\" stroke-width=\"3\"></path> <path d=\"M190 136 C 198 126 182 118 172 128 C 170 138 180 144 190 136 Z\" fill=\"#3a2228\" stroke=\"#1d1517\" stroke-width=\"3\"></path> <path d=\"M106 124 q8 -8 22 0 M194 124 q-8 -8 -22 0\" fill=\"none\" stroke=\"#1d1517\" stroke-width=\"2.5\"></path> <g fill=\"#7d6066\"><circle cx=\"76\" cy=\"176\" r=\"2\"></circle><circle cx=\"86\" cy=\"184\" r=\"2\"></circle><circle cx=\"72\" cy=\"188\" r=\"2\"></circle><circle cx=\"90\" cy=\"172\" r=\"2\"></circle><circle cx=\"224\" cy=\"176\" r=\"2\"></circle><circle cx=\"214\" cy=\"184\" r=\"2\"></circle><circle cx=\"228\" cy=\"188\" r=\"2\"></circle><circle cx=\"210\" cy=\"172\" r=\"2\"></circle></g> <ellipse cx=\"72\" cy=\"168\" rx=\"14\" ry=\"7\" fill=\"#e0505f\" opacity=\"0.28\"></ellipse> <ellipse cx=\"228\" cy=\"168\" rx=\"14\" ry=\"7\" fill=\"#e0505f\" opacity=\"0.28\"></ellipse> <g data-o=\"steam\" fill=\"#ffffff\" stroke=\"#1d1517\" stroke-width=\"3\"> <path d=\"M96 120 C 82 124 70 116 74 104 C 64 98 70 84 82 88 C 84 76 100 76 102 88 C 112 86 114 98 106 104 C 108 112 104 118 96 120 Z\"></path> <path d=\"M204 120 C 218 124 230 116 226 104 C 236 98 230 84 218 88 C 216 76 200 76 198 88 C 188 86 186 98 194 104 C 192 112 196 118 204 120 Z\"></path> <circle cx=\"62\" cy=\"76\" r=\"7\"></circle><circle cx=\"238\" cy=\"76\" r=\"7\"></circle> </g> <g data-o=\"swoosh\" fill=\"none\" stroke=\"#9aa0bd\" stroke-width=\"5\"> <path d=\"M268 150 C 296 180 296 222 274 248\"></path><path d=\"M252 136 C 276 170 278 206 264 232\" stroke-width=\"3\"></path> </g> <g data-a=\"arm\" data-base=\"translate(214 244)\"> <path d=\"M-31 10 C -35 -28 -27 -62 -21 -86 L 21 -86 C 27 -62 35 -28 31 10 Z\" fill=\"#8f7f85\" stroke=\"#1d1517\" stroke-width=\"5\"></path> <path d=\"M31 10 C 35 -28 27 -62 21 -86 L 12 -86 C 18 -60 22 -28 18 10 Z\" fill=\"#6c5e63\"></path> <path d=\"M-24 -30 q12 -4 22 0 M-22 -48 q10 -4 20 0\" fill=\"none\" stroke=\"#5a4d52\" stroke-width=\"2.5\"></path> <g data-a=\"paw\" data-base=\"translate(0 -106)\"> <g data-o=\"backOp\"> <path d=\"M-33 14 C -37 -2 -35 -18 -29 -24 C -29 -35 -15 -37 -14 -26 C -13 -38 0 -39 0 -27 C 0 -39 13 -38 14 -26 C 15 -37 29 -35 29 -24 C 35 -18 37 -2 33 14 C 27 29 -27 29 -33 14 Z\" fill=\"#8f7f85\" stroke=\"#1d1517\" stroke-width=\"5\"></path> <path d=\"M33 14 C 27 29 -27 29 -33 14 C -18 21 18 21 33 14 Z M29 -24 C 35 -18 37 -2 33 14 C 30 2 28 -12 24 -18 Z\" fill=\"#6c5e63\"></path> <path d=\"M-14 -26 C -14 -19 -13 -14 -12 -10 M0 -27 C 0 -20 0 -15 0 -11 M14 -26 C 14 -19 13 -14 12 -10\" fill=\"none\" stroke=\"#1d1517\" stroke-width=\"2.4\"></path> <path d=\"M-24 -8 q6 -5 12 0 M-6 -10 q6 -5 12 0 M12 -8 q6 -5 12 0 M-20 2 q20 -6 40 0\" fill=\"none\" stroke=\"#5a4d52\" stroke-width=\"2.4\"></path> <path d=\"M-28 -27 C -28 -35 -16 -35 -16 -27 C -20 -25 -24 -25 -28 -27 Z M-12 -30 C -12 -39 0 -39 0 -30 C -4 -28 -8 -28 -12 -30 Z M0 -30 C 0 -39 12 -39 12 -30 C 8 -28 4 -28 0 -30 Z M16 -27 C 16 -35 28 -35 28 -27 C 24 -25 20 -25 16 -27 Z\" fill=\"#efe4d6\" stroke=\"#1d1517\" stroke-width=\"2\"></path> </g> <g data-o=\"palmOp\"> <path d=\"M-33 14 C -37 -2 -35 -18 -29 -24 C -29 -35 -15 -37 -14 -26 C -13 -38 0 -39 0 -27 C 0 -39 13 -38 14 -26 C 15 -37 29 -35 29 -24 C 35 -18 37 -2 33 14 C 27 29 -27 29 -33 14 Z\" fill=\"#8f7f85\" stroke=\"#1d1517\" stroke-width=\"5\"></path> <path d=\"M33 14 C 27 29 -27 29 -33 14 C -18 21 18 21 33 14 Z\" fill=\"#6c5e63\"></path> <path d=\"M-14 -26 C -14 -20 -13 -15 -11 -12 M0 -27 C 0 -21 0 -16 0 -13 M14 -26 C 14 -20 13 -15 11 -12\" fill=\"none\" stroke=\"#1d1517\" stroke-width=\"2.2\"></path> <path d=\"M-20 4 C -20 -6 20 -6 20 4 C 20 16 -20 16 -20 4 Z\" fill=\"#c99a9c\" stroke=\"#8f6468\" stroke-width=\"1.8\"></path> <path d=\"M-10 6 q10 4 20 0\" fill=\"none\" stroke=\"#8f6468\" stroke-width=\"1.6\"></path> <path d=\"M-28 -27 C -28 -35 -16 -35 -16 -27 C -20 -25 -24 -25 -28 -27 Z\" fill=\"#efe4d6\" stroke=\"#1d1517\" stroke-width=\"2\"></path> <path d=\"M-12 -30 C -12 -39 0 -39 0 -30 C -4 -28 -8 -28 -12 -30 Z\" fill=\"#efe4d6\" stroke=\"#1d1517\" stroke-width=\"2\"></path> <path d=\"M0 -30 C 0 -39 12 -39 12 -30 C 8 -28 4 -28 0 -30 Z\" fill=\"#efe4d6\" stroke=\"#1d1517\" stroke-width=\"2\"></path> <path d=\"M16 -27 C 16 -35 28 -35 28 -27 C 24 -25 20 -25 16 -27 Z\" fill=\"#efe4d6\" stroke=\"#1d1517\" stroke-width=\"2\"></path> </g> </g> </g> </g> </g> </g> </svg>", "palm": "<svg viewBox=\"-42 -56 84 90\" aria-hidden=\"true\"> <g stroke-linecap=\"round\" stroke-linejoin=\"round\"> <path d=\"M-33 14 C -37 -2 -35 -18 -29 -24 C -29 -35 -15 -37 -14 -26 C -13 -38 0 -39 0 -27 C 0 -39 13 -38 14 -26 C 15 -37 29 -35 29 -24 C 35 -18 37 -2 33 14 C 27 29 -27 29 -33 14 Z\" fill=\"#8f7f85\" stroke=\"#1d1517\" stroke-width=\"5\"></path> <path d=\"M33 14 C 27 29 -27 29 -33 14 C -18 21 18 21 33 14 Z\" fill=\"#6c5e63\"></path> <path d=\"M-14 -26 C -14 -20 -13 -15 -11 -12 M0 -27 C 0 -21 0 -16 0 -13 M14 -26 C 14 -20 13 -15 11 -12\" fill=\"none\" stroke=\"#1d1517\" stroke-width=\"2.2\"></path> <path d=\"M-20 4 C -20 -6 20 -6 20 4 C 20 16 -20 16 -20 4 Z\" fill=\"#c99a9c\" stroke=\"#8f6468\" stroke-width=\"1.8\"></path> <path d=\"M-10 6 q10 4 20 0\" fill=\"none\" stroke=\"#8f6468\" stroke-width=\"1.6\"></path> <path d=\"M-28 -27 C -28 -35 -16 -35 -16 -27 C -20 -25 -24 -25 -28 -27 Z\" fill=\"#efe4d6\" stroke=\"#1d1517\" stroke-width=\"2\"></path> <path d=\"M-12 -30 C -12 -39 0 -39 0 -30 C -4 -28 -8 -28 -12 -30 Z\" fill=\"#efe4d6\" stroke=\"#1d1517\" stroke-width=\"2\"></path> <path d=\"M0 -30 C 0 -39 12 -39 12 -30 C 8 -28 4 -28 0 -30 Z\" fill=\"#efe4d6\" stroke=\"#1d1517\" stroke-width=\"2\"></path> <path d=\"M16 -27 C 16 -35 28 -35 28 -27 C 24 -25 20 -25 16 -27 Z\" fill=\"#efe4d6\" stroke=\"#1d1517\" stroke-width=\"2\"></path> </g> </svg>", "print": "<svg viewBox=\"0 0 200 200\" aria-hidden=\"true\"> <g fill=\"#c99a9c\" stroke=\"#1d1517\" stroke-width=\"6\" opacity=\"0.92\"> <path d=\"M100 58 c48 0 74 30 72 66 c-2 38 -34 58 -72 58 c-38 0 -70 -20 -72 -58 c-2 -36 24 -66 72 -66 z\"></path> <ellipse cx=\"52\" cy=\"48\" rx=\"20\" ry=\"17\"></ellipse><ellipse cx=\"86\" cy=\"30\" rx=\"20\" ry=\"17\"></ellipse> <ellipse cx=\"122\" cy=\"30\" rx=\"20\" ry=\"17\"></ellipse><ellipse cx=\"154\" cy=\"48\" rx=\"20\" ry=\"17\"></ellipse> </g> </svg>"}};

export function pickCritter(pref) {
  if (pref === 'off') return null;
  if (pref === 'cat' || pref === 'hippo') return pref;
  return Math.random() < 0.5 ? 'cat' : 'hippo';
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- Motion: damped springs driven by a short timeline ----------
function makeRig() {
  const S = (x, k, c) => ({ x, v: 0, t: x, k, c });
  return {
    y: S(400, 170, 13), sx: S(0.9, 230, 9), sy: S(1.14, 230, 9), lean: S(0, 140, 13),
    arm: S(22, 170, 15), paw: S(1, 210, 16), face: S(-1, 270, 22),
    squeeze: S(0, 420, 30), mouth: S(0, 330, 24),
  };
}
function setT(rig, n, v, k, c) { const ch = rig[n]; ch.t = v; if (k) { ch.k = k; ch.c = c; } }
function stepRig(rig, dt) {
  const n = Math.max(1, Math.ceil(dt / (1 / 240))), h = dt / n;
  for (let i = 0; i < n; i++) for (const key in rig) { const c = rig[key]; const a = c.k * (c.t - c.x) - c.c * c.v; c.v += a * h; c.x += c.v * h; }
}

class Critter {
  constructor(kind, el, { mini = false, onSmack, onSwing, onDone } = {}) {
    this.kind = kind; this.el = el; this.mini = mini;
    this.onSmack = onSmack; this.onSwing = onSwing; this.onDone = onDone;
    this.rig = makeRig(); this.t = -0.1; this.phase = 0; this.smackAt = null; this.windAt = null;
    this.nodes = {};
    el.querySelectorAll('[data-a]').forEach((n) => { this.nodes[n.dataset.a] = n; });
    this.ops = [...el.querySelectorAll('[data-o]')];
    this.last = null;
    this.raf = requestAnimationFrame((ts) => this.frame(ts));
  }
  frame(ts) {
    if (this.last == null) this.last = ts;
    const dt = Math.min(0.05, (ts - this.last) / 1000);
    this.last = ts;
    this.advance(dt);
    this.paint();
    if (this.phase === 7) { this.onDone && this.onDone(); return; }
    this.raf = requestAnimationFrame((t2) => this.frame(t2));
  }
  advance(dt) {
    this.t += dt;
    const t = this.t, r = this.rig;
    if (this.phase === 0 && t >= 0) { setT(r, 'y', 0); setT(r, 'sx', 1); setT(r, 'sy', 1); this.phase = 1; }
    if (this.phase === 1 && t >= 0.55) {
      setT(r, 'arm', 60, 120, 13); setT(r, 'paw', 0.92); setT(r, 'lean', 5, 120, 12);
      setT(r, 'sx', 1.04, 160, 12); setT(r, 'sy', 0.95, 160, 12); setT(r, 'squeeze', 1);
      this.windAt = t; this.phase = 2;
    }
    if (this.phase === 2 && t >= 1.0) {
      setT(r, 'arm', -24, 540, 22); setT(r, 'paw', this.mini ? 1.25 : 1.5, 430, 20); setT(r, 'face', 1, 540, 30);
      setT(r, 'lean', -7, 390, 18); setT(r, 'sx', 0.96, 390, 15); setT(r, 'sy', 1.06, 390, 15);
      setT(r, 'squeeze', 0); setT(r, 'mouth', 1);
      this.phase = 3; this.onSwing && this.onSwing();
    }
    if (this.phase === 3 && r.arm.x <= -6) { this.smackAt = t; this.phase = 4; r.sy.v -= 1.2; this.onSmack && this.onSmack(); }
    if (this.phase === 4 && t >= this.smackAt + 0.5) {
      setT(r, 'arm', 22, 160, 14); setT(r, 'paw', 1, 190, 16); setT(r, 'face', -1, 230, 22);
      setT(r, 'lean', 0, 130, 12); setT(r, 'sx', 1, 180, 10); setT(r, 'sy', 1, 180, 10); setT(r, 'mouth', 0);
      this.phase = 5;
    }
    if (this.phase === 5 && t >= this.smackAt + 1.05) { setT(r, 'y', 440, 110, 14); setT(r, 'sy', 1.08, 190, 10); setT(r, 'sx', 0.94, 190, 10); this.phase = 6; }
    if (this.phase === 6 && t >= this.smackAt + 1.75) this.phase = 7;
    stepRig(r, dt);
  }
  values() {
    const r = this.rig, t = this.t;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const since = this.smackAt == null ? 99 : t - this.smackAt;
    const turn = Math.max(0.12, Math.abs(clamp(r.face.x, -1, 1)));
    const mouth = clamp(r.mouth.x, 0, 1);
    return {
      since, turn, mouth,
      o: {
        palmOp: r.face.x >= 0 ? 1 : 0, backOp: r.face.x >= 0 ? 0 : 1,
        eyesOpen: clamp(1 - r.squeeze.x, 0, 1), eyesShut: clamp(r.squeeze.x, 0, 1),
        smirk: clamp(1 - mouth * 3, 0, 1), hiss: clamp(mouth * 3, 0, 1),
        jawShut: clamp(1 - mouth * 3, 0, 1), jawOpen: clamp(mouth * 3, 0, 1),
        steam: this.windAt != null && t >= this.windAt && this.phase >= 2 && this.phase <= 4 ? 1 : 0,
        swoosh: this.phase === 2 ? clamp((t - this.windAt) / 0.2, 0, 1) * 0.9 : 0,
        impact: 0,
      },
    };
  }
  paint() {
    const r = this.rig, v = this.values(), N = this.nodes, f = (x) => Math.round(x * 1000) / 1000;
    N.root && N.root.setAttribute('transform', `translate(0 ${f(r.y.x)}) translate(150 340) scale(${f(r.sx.x)} ${f(r.sy.x)}) translate(-150 -340)`);
    N.lean && N.lean.setAttribute('transform', `rotate(${f(r.lean.x)} 150 340)`);
    N.arm && N.arm.setAttribute('transform', `${N.arm.dataset.base} rotate(${f(r.arm.x)})`);
    if (N.paw) {
      N.paw.setAttribute('transform', `${N.paw.dataset.base} scale(${f(r.paw.x * v.turn)} ${f(r.paw.x)})`);
      const hidden = !this.mini && v.since > 0.02 && v.since < 0.45;
      N.paw.setAttribute('opacity', hidden ? '0' : '1');
    }
    for (const n of this.ops) { const val = v.o[n.dataset.o]; if (val !== undefined) n.setAttribute('opacity', String(f(val))); }
  }
  stop() { cancelAnimationFrame(this.raf); }
}

// ---------- Full screen: the palm smacks the glass ----------
export function slapMe(kind, title, sub, onImpact) {
  if (reduced()) { onImpact && onImpact(); return 0; }
  const art = ART[kind];
  const el = document.createElement('div');
  el.className = `slap ${kind}`;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `
    <div class="slap-print">${art.print}</div>
    <div class="slap-char">${art.svg}</div>
    <div class="slap-big">${art.palm}</div>
    <div class="slap-flash"></div>
    <div class="slap-burst"><div class="slap-star"><b>${title}</b></div>${sub ? `<span>${sub}</span>` : ''}</div>`;
  document.body.appendChild(el);
  const big = el.querySelector('.slap-big'), flash = el.querySelector('.slap-flash');
  const printEl = el.querySelector('.slap-print'), burst = el.querySelector('.slap-burst');
  const game = document.querySelector('#table');
  const ease = (x) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
  let smackT = null;
  const fx = () => {
    if (smackT == null) return;
    const since = (performance.now() - smackT) / 1000;
    let s = 0, op = 0, sx = 1, sy = 1;
    if (since < 0.62) {
      if (since < 0.07) { s = 0.25 + 0.85 * ease(since / 0.07); op = 1; }
      else if (since < 0.13) { const k = (since - 0.07) / 0.06; s = 1.1 - 0.1 * k; sx = 1 + 0.14 * Math.sin(k * Math.PI); sy = 1 - 0.12 * Math.sin(k * Math.PI); op = 1; }
      else if (since < 0.4) { s = 1; op = 1; }
      else { const k = (since - 0.4) / 0.22; s = 1 - 0.45 * ease(k); op = 1 - ease(k); }
    }
    big.style.opacity = op;
    big.style.transform = `translate(-50%, -50%) rotate(-10deg) scale(${s * sx}, ${s * sy})`;
    const after = since - 0.07;
    const hit = after >= 0;
    flash.style.opacity = hit ? Math.exp(-after * 11) * 0.8 : 0;
    printEl.style.opacity = !hit ? 0 : after < 0.33 ? 0 : after < 1.2 ? 1 : Math.max(0, 1 - (after - 1.2) / 0.5);
    const bs = !hit ? 0 : (1 - Math.exp(-after * 22)) * (1 + 0.12 * Math.sin(after * 28) * Math.exp(-after * 5));
    burst.style.opacity = !hit ? 0 : Math.max(0, Math.min(1, 1 - (after - 1.3) / 0.35));
    burst.style.transform = `translateX(-50%) scale(${Math.max(0.001, bs)})`;
    if (game) {
      const sh = hit ? Math.exp(-after * 6) : 0;
      game.style.transform = sh > 0.01 ? `translate(${13 * sh * Math.sin(after * 80)}px, ${9 * sh * Math.cos(after * 63)}px)` : '';
    }
    if (since < 2.2) requestAnimationFrame(fx);
  };
  new Critter(kind, el.querySelector('.slap-char'), {
    onSmack: () => {
      smackT = performance.now();
      requestAnimationFrame(fx);
      setTimeout(() => {
        onImpact && onImpact();
        if (navigator.vibrate) { try { navigator.vibrate([60, 30, 40]); } catch {} }
      }, 70);
    },
    onDone: () => { el.remove(); if (game) game.style.transform = ''; },
  });
  setTimeout(() => { el.remove(); if (game) game.style.transform = ''; }, 5000);
  return 1000;
}

// ---------- Mini: smacks the avatar of the player who got the thulla ----------
export function slapSeat(kind, seatEl, onImpact) {
  if (reduced() || !seatEl) { onImpact && onImpact(); return; }
  const ring = seatEl.querySelector('.ring') || seatEl;
  const r = ring.getBoundingClientRect();
  const flip = r.left + r.width / 2 > window.innerWidth * 0.6;
  const w = Math.max(84, r.height * 2.4);
  const el = document.createElement('div');
  el.className = `slap-mini ${kind}${flip ? ' flip' : ''}`;
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, {
    width: w + 'px',
    left: (flip ? r.left - w * 0.86 : r.right - w * 0.14) + 'px',
    top: (r.top + r.height / 2 - w * 0.8) + 'px',
  });
  el.innerHTML = `<div class="slap-mini-clip">${ART[kind].svg}</div>`;
  document.body.appendChild(el);
  new Critter(kind, el, {
    mini: true,
    onSmack: () => {
      ring.classList.remove('slapped'); void ring.offsetWidth; ring.classList.add('slapped');
      setTimeout(() => ring.classList.remove('slapped'), 600);
      onImpact && onImpact();
    },
    onDone: () => el.remove(),
  });
  setTimeout(() => el.remove(), 5000);
}
