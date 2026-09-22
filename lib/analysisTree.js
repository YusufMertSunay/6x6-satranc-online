// lib/analysisTree.js
//
// Analiz tahtasındaki hamle AĞACI (lichess'teki gibi "varyant" desteği) için
// saf veri yapısı yardımcıları -- motor/FEN bilgisiyle HİÇ ilgilenmez, sadece
// düğümleri (node) ekleme/silme/yol bulma gibi işlemleri yapar. FEN/SAN
// hesaplama (motor gerektirdiği için) server.js tarafında yapılıp buraya
// hazır olarak veriliyor.
//
// Bir ağaç şu şekilde saklanır:
//   {
//     startFen: "...",              // bu ağacın başlangıç pozisyonu
//     nodes: { [id]: Node },        // TÜM düğümler (düz bir harita)
//     rootChildren: [id, id, ...],  // başlangıç pozisyonundan oynanan hamleler
//     nextId: 3                     // bir sonraki düğüme verilecek id sayacı
//   }
// Node: { id, parentId (null ise kökün çocuğu), uci, san, isBook, children: [id,...] }
//
// "isBook": bu düğüm, GERÇEK oyunun (oyun-bazlı analizde) ana hattının bir
// parçası mı? true ise SİLİNEMEZ (server.js bunu ayrıca da kontrol eder).
// Serbest (oyunsuz) analizde hiçbir düğüm isBook değildir -- hepsi silinebilir.

function createEmptyTree(startFen) {
  return { startFen, nodes: {}, rootChildren: [], nextId: 1 };
}

function addNode(tree, { parentId, uci, san, isBook }) {
  const id = String(tree.nextId++);
  const node = { id, parentId: parentId || null, uci, san, isBook: !!isBook, children: [] };
  tree.nodes[id] = node;
  if (parentId) {
    tree.nodes[parentId].children.push(id);
  } else {
    tree.rootChildren.push(id);
  }
  return node;
}

function childIdsOf(tree, parentId) {
  return parentId ? (tree.nodes[parentId] ? tree.nodes[parentId].children : []) : tree.rootChildren;
}

function findChildByUci(tree, parentId, uci) {
  for (const id of childIdsOf(tree, parentId)) {
    if (tree.nodes[id].uci === uci) return tree.nodes[id];
  }
  return null;
}

// parentId'ye kadar olan (kökten parentId'ye) hamlelerin (uci) DİZİSİNİ verir
// -- yeni bir hamlenin FEN'ini hesaplamak için gereken "önceki hamleler" listesi.
function uciPathTo(tree, parentId) {
  const moves = [];
  let cur = parentId;
  while (cur) {
    const node = tree.nodes[cur];
    moves.unshift(node.uci);
    cur = node.parentId;
  }
  return moves;
}

// Bir düğümü VE tüm alt ağacını (çocukları, çocuklarının çocukları...) siler.
function deleteSubtree(tree, nodeId) {
  const node = tree.nodes[nodeId];
  if (!node) return;
  for (const childId of node.children.slice()) deleteSubtree(tree, childId);
  const siblings = childIdsOf(tree, node.parentId);
  const idx = siblings.indexOf(nodeId);
  if (idx !== -1) siblings.splice(idx, 1);
  delete tree.nodes[nodeId];
}

module.exports = { createEmptyTree, addNode, childIdsOf, findChildByUci, uciPathTo, deleteSubtree };
