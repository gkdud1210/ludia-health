<?php
// ══════════════════════════════════════════════════════
//  LUDIA HEALTH — API 엔드포인트
// ══════════════════════════════════════════════════════
if (!file_exists(__DIR__ . '/config.php')) {
    http_response_code(500);
    echo json_encode(['error' => 'config.php가 없습니다.']);
    exit;
}
require_once __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache, no-store');

// ─── Session ───────────────────────────────────────────
session_name('LUDIA_SID');
ini_set('session.cookie_samesite', 'Lax');
session_start();

// ─── DB (lazy singleton) ───────────────────────────────
function db() {
    static $pdo = null;
    if ($pdo === null) {
        try {
            $pdo = new PDO(
                'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
                DB_USER, DB_PASS,
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                 PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
            );
        } catch (PDOException $e) {
            respond(['error' => 'DB 오류: ' . $e->getMessage()], 500);
        }
    }
    return $pdo;
}

function respond($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function gen_id() { return bin2hex(random_bytes(12)); }

function require_auth() {
    if (empty($_SESSION['user_id'])) respond(['error' => '로그인이 필요합니다.'], 401);
    return $_SESSION;
}
function require_super() {
    $s = require_auth();
    if ($s['role'] !== 'super_admin') respond(['error' => '최종관리자만 접근 가능합니다.'], 403);
    return $s;
}

// ─── Input ─────────────────────────────────────────────
$raw   = file_get_contents('php://input');
$input = json_decode($raw, true) ?: [];
$action = $_GET['action'] ?? ($input['action'] ?? '');

switch ($action) {
    // Auth
    case 'login':          handle_login($input);         break;
    case 'super_login':    handle_super_login($input);   break;
    case 'logout':         handle_logout();               break;
    case 'me':             handle_me();                   break;

    // Admins
    case 'list_admins':    handle_list_admins();          break;
    case 'create_admin':   handle_create_admin($input);   break;
    case 'delete_admin':   handle_delete_admin($input);   break;
    case 'self_register':  handle_self_register($input);  break;

    // Patients
    case 'get_patients':   handle_get_patients();         break;
    case 'save_patient':   handle_save_patient($input);   break;
    case 'delete_patient': handle_delete_patient($input); break;

    // Visits
    case 'save_visit':     handle_save_visit($input);     break;
    case 'delete_visit':   handle_delete_visit($input);   break;

    // Intake
    case 'get_intake':        handle_get_intake();              break;
    case 'save_intake':       handle_save_intake($input);       break;
    case 'set_intake_status': handle_set_intake_status($input); break;
    case 'deliver_report':    handle_deliver_report($input);    break;
    case 'forward_patient':   handle_forward_patient($input);   break;
    case 'save_intake_memo':  handle_save_intake_memo($input);  break;
    case 'get_intake_photos': handle_get_intake_photos($input); break;
    case 'delete_intake':     handle_delete_intake($input);     break;

    // Invite codes
    case 'create_invite_code': handle_create_invite_code(); break;
    case 'list_invite_codes':  handle_list_invite_codes();  break;
    case 'delete_invite_code': handle_delete_invite_code($input); break;

    // Member view
    case 'get_my_patient': handle_get_my_patient();       break;

    // Migration (localStorage → MySQL)
    case 'migrate':        handle_migrate($input);        break;

    // RAG 케이스 DB
    case 'save_case':          handle_save_case($input);          break;
    case 'delete_case':        handle_delete_case($input);        break;
    case 'delete_all_cases':   handle_delete_all_cases();         break;
    case 'list_cases':         handle_list_cases();               break;
    case 'get_similar_cases':  handle_get_similar_cases($input);  break;

    // 증상/질병/수술 커스텀 태그
    case 'get_taxonomy':       handle_get_taxonomy();             break;
    case 'add_taxonomy_item':  handle_add_taxonomy_item($input);  break;

    // 홍채 그리드 라벨링
    case 'save_iris_grid_label':    handle_save_iris_grid_label($input);  break;
    case 'get_iris_grid_labels':    handle_get_iris_grid_labels($input);  break;
    case 'export_iris_grid_dataset':handle_export_iris_grid_dataset();    break;

    default:
        respond(['error' => '알 수 없는 action: ' . htmlspecialchars($action)], 400);
}

// ══════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════

function set_session($user, $remember = false) {
    $_SESSION['user_id']             = $user['id'];
    $_SESSION['name']                = $user['name'];
    $_SESSION['role']                = $user['role'];
    $_SESSION['admin_code']          = $user['admin_code'] ?? '';
    $_SESSION['email']               = $user['email'] ?? '';
    $_SESSION['linked_patient_uid']  = $user['linked_patient_uid'] ?? '';
    $_SESSION['linked_patient_name'] = $user['linked_patient_name'] ?? '';

    if ($remember) {
        $p = session_get_cookie_params();
        setcookie(session_name(), session_id(),
            time() + 86400 * 30, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
    }
}

function session_data() {
    return [
        'userId'              => $_SESSION['user_id'],
        'name'                => $_SESSION['name'],
        'role'                => $_SESSION['role'],
        'adminCode'           => $_SESSION['admin_code'] ?? '',
        'email'               => $_SESSION['email'] ?? '',
        'isSuperAdmin'        => ($_SESSION['role'] === 'super_admin'),
        'linkedPatientUniqueId'  => $_SESSION['linked_patient_uid'] ?? '',
        'linkedPatientName'   => $_SESSION['linked_patient_name'] ?? '',
    ];
}

function check_password($pw, $hash) {
    if (strpos($hash, '$2y$') === 0) {
        return password_verify($pw, $hash);
    }
    return ($hash === legacy_hash($pw));
}

// 기존 localStorage simpleHash 호환 (마이그레이션용)
function legacy_hash($str) {
    $h = 5381;
    $len = strlen($str);
    for ($i = 0; $i < $len; $i++) {
        $h = (($h << 5) + $h) ^ ord($str[$i]);
        $h = $h & 0xFFFFFFFF;
        if ($h >= 0x80000000) $h -= 0x100000000;
    }
    $u = ($h < 0) ? ($h + 0x100000000) : $h;
    return base_convert((string)(int)$u, 10, 36);
}

function handle_login($in) {
    $email    = strtolower(trim($in['email'] ?? ''));
    $pw       = $in['password'] ?? '';
    $remember = !empty($in['remember']);

    if (!$email || !$pw) respond(['error' => '이메일과 비밀번호를 입력해주세요.'], 400);

    $stmt = db()->prepare("SELECT * FROM ludia_users WHERE email = ? AND role != 'super_admin' LIMIT 1");
    $stmt->execute([$email]);
    $user = $stmt->fetch();

    if (!$user || !check_password($pw, $user['password_hash'] ?? ''))
        respond(['error' => '이메일 또는 비밀번호가 올바르지 않습니다.'], 401);

    set_session($user, $remember);
    respond(['success' => true, 'user' => session_data()]);
}

function handle_super_login($in) {
    $pw       = $in['password'] ?? '';
    $remember = !empty($in['remember']);

    if (!$pw) respond(['error' => '비밀번호를 입력해주세요.'], 400);

    $stmt = db()->query("SELECT * FROM ludia_users WHERE role = 'super_admin' LIMIT 1");
    $user = $stmt->fetch();

    if (!$user || !check_password($pw, $user['password_hash'] ?? ''))
        respond(['error' => '비밀번호가 올바르지 않습니다.'], 401);

    set_session($user, $remember);
    respond(['success' => true, 'user' => session_data()]);
}

function handle_logout() {
    session_destroy();
    respond(['success' => true]);
}

function handle_me() {
    if (empty($_SESSION['user_id'])) respond(['loggedIn' => false]);
    respond(['loggedIn' => true, 'user' => session_data()]);
}

// ══════════════════════════════════════════════════════
//  ADMINS
// ══════════════════════════════════════════════════════

function handle_list_admins() {
    require_super();
    $stmt = db()->query("SELECT id, name, email, phone, admin_code, role, created_at FROM ludia_users ORDER BY created_at DESC");
    $admins = array_map(function($u) {
        $u['adminCode']  = $u['admin_code']  ?? '';
        $u['createdAt']  = $u['created_at']  ?? '';
        $u['isSuperAdmin'] = ($u['role'] === 'super_admin');
        return $u;
    }, $stmt->fetchAll());
    respond(['success' => true, 'admins' => $admins]);
}

function handle_create_admin($in) {
    require_super();
    $name  = trim($in['name']  ?? '');
    $email = strtolower(trim($in['email'] ?? ''));
    $pw    = $in['password'] ?? '';
    $phone = preg_replace('/\D/', '', $in['phone'] ?? '');

    if (!$name || !$email || !$pw || !$phone) respond(['error' => '모든 항목을 입력해주세요.'], 400);
    if (strlen($pw) < 6) respond(['error' => '비밀번호는 6자 이상이어야 합니다.'], 400);
    if (strlen($phone) < 7) respond(['error' => '핸드폰 번호를 올바르게 입력해주세요.'], 400);

    $admin_code = strlen($phone) >= 4 ? substr($phone, 3) : $phone;

    $stmt = db()->prepare("SELECT id FROM ludia_users WHERE email = ? LIMIT 1");
    $stmt->execute([$email]);
    if ($stmt->fetch()) respond(['error' => '이미 사용 중인 이메일입니다.'], 409);

    $stmt = db()->prepare("SELECT id FROM ludia_users WHERE admin_code = ? LIMIT 1");
    $stmt->execute([$admin_code]);
    if ($stmt->fetch()) respond(['error' => '이미 등록된 핸드폰 번호입니다. (관리자 코드 중복)'], 409);

    $id   = 'usr_' . gen_id();
    $hash = password_hash($pw, PASSWORD_BCRYPT);

    db()->prepare("INSERT INTO ludia_users (id, name, email, phone, password_hash, role, admin_code, created_at) VALUES (?, ?, ?, ?, ?, 'admin', ?, NOW())")
       ->execute([$id, $name, $email, $phone, $hash, $admin_code]);

    respond(['success' => true, 'admin' => ['id' => $id, 'name' => $name, 'email' => $email, 'admin_code' => $admin_code, 'role' => 'admin']]);
}

function handle_delete_admin($in) {
    require_super();
    $uid = $in['id'] ?? '';
    if (!$uid) respond(['error' => 'id가 필요합니다.'], 400);
    db()->prepare("DELETE FROM ludia_users WHERE id = ? AND role != 'super_admin'")->execute([$uid]);
    respond(['success' => true]);
}

function handle_self_register($in) {
    $name  = trim($in['name']  ?? '');
    $email = strtolower(trim($in['email'] ?? ''));
    $pw    = $in['password'] ?? '';
    $phone = preg_replace('/\D/', '', $in['phone'] ?? '');
    $role  = in_array($in['role'] ?? '', ['admin', 'member']) ? $in['role'] : 'admin';

    if (!$name || !$email || !$pw) respond(['error' => '모든 항목을 입력해주세요.'], 400);
    if (strlen($pw) < 6) respond(['error' => '비밀번호는 6자 이상이어야 합니다.'], 400);

    $stmt = db()->prepare("SELECT id FROM ludia_users WHERE email = ? LIMIT 1");
    $stmt->execute([$email]);
    if ($stmt->fetch()) respond(['error' => '이미 사용 중인 이메일입니다.'], 409);

    $admin_code = null;
    if ($role === 'admin' && $phone) {
        $admin_code = strlen($phone) >= 4 ? substr($phone, 3) : $phone;
        $stmt = db()->prepare("SELECT id FROM ludia_users WHERE admin_code = ? LIMIT 1");
        $stmt->execute([$admin_code]);
        if ($stmt->fetch()) respond(['error' => '이미 등록된 핸드폰 번호입니다. (관리자 코드 중복)'], 409);
    }

    $linked_uid = null; $linked_name = null;
    if ($role === 'member') {
        $invite_code = strtoupper(trim($in['inviteCode'] ?? ''));
        $patient_uid = strtoupper(trim($in['patientUniqueId'] ?? ''));

        if (!$invite_code) respond(['error' => '초대 코드를 입력해주세요.'], 400);
        if (!$patient_uid) respond(['error' => '어르신 고유번호를 입력해주세요.'], 400);

        // Validate invite code
        $stmt = db()->prepare("SELECT * FROM ludia_invite_codes WHERE code = ? AND used = 0 LIMIT 1");
        $stmt->execute([$invite_code]);
        $code_row = $stmt->fetch();
        if (!$code_row) respond(['error' => '유효하지 않은 초대 코드입니다.'], 400);

        // Validate patient UID
        $stmt = db()->prepare("SELECT id, name FROM ludia_patients WHERE unique_id = ? LIMIT 1");
        $stmt->execute([$patient_uid]);
        $patient = $stmt->fetch();
        if (!$patient) respond(['error' => '어르신 고유번호를 찾을 수 없습니다. 담당 관리자에게 확인하세요.'], 400);

        $linked_uid  = $patient_uid;
        $linked_name = $patient['name'];
    }

    $id   = 'usr_' . gen_id();
    $hash = password_hash($pw, PASSWORD_BCRYPT);

    db()->prepare("INSERT INTO ludia_users (id, name, email, phone, password_hash, role, admin_code, linked_patient_uid, linked_patient_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())")
       ->execute([$id, $name, $email, $phone, $hash, $role, $admin_code, $linked_uid, $linked_name]);

    // Mark invite code as used
    if ($role === 'member' && isset($invite_code)) {
        db()->prepare("UPDATE ludia_invite_codes SET used=1, used_by=?, used_at=NOW() WHERE code=?")
           ->execute([$id, $invite_code]);
    }

    $user = ['id' => $id, 'name' => $name, 'email' => $email, 'role' => $role,
             'admin_code' => $admin_code,
             'linked_patient_uid' => $linked_uid, 'linked_patient_name' => $linked_name];
    set_session($user, false);
    respond(['success' => true, 'user' => session_data()]);
}

// ══════════════════════════════════════════════════════
//  PATIENTS
// ══════════════════════════════════════════════════════

function get_patient_with_visits($patient) {
    // Add camelCase aliases for frontend compatibility
    $patient['uniqueId']     = $patient['unique_id']  ?? '';
    $patient['adminId']      = $patient['admin_id']   ?? '';
    $patient['adminName']    = $patient['admin_name'] ?? '';
    $patient['createdAt']    = $patient['created_at'] ?? '';
    $patient['createdBy']    = $patient['admin_id']   ?? '';
    $patient['createdByName']= $patient['admin_name'] ?? '';

    $patient['survey']     = json_decode($patient['survey_data']     ?? 'null', true) ?? [];
    $patient['irisPhotos'] = json_decode($patient['iris_photos_data'] ?? 'null', true);
    unset($patient['survey_data'], $patient['iris_photos_data']);

    $vstmt = db()->prepare("SELECT id, visit_date, visit_data FROM ludia_visits WHERE patient_id = ? ORDER BY visit_date ASC");
    $vstmt->execute([$patient['id']]);
    $visits = $vstmt->fetchAll();

    $patient['visits'] = array_map(function($v) {
        $vdata = json_decode($v['visit_data'] ?? '{}', true) ?? [];
        $vdata['id'] = $v['id'];
        if (empty($vdata['date'])) $vdata['date'] = $v['visit_date'];
        return $vdata;
    }, $visits);

    return $patient;
}

function handle_get_patients() {
    $sess = require_auth();

    if ($sess['role'] === 'super_admin') {
        $stmt = db()->query("SELECT p.*, u.name AS admin_display_name FROM ludia_patients p LEFT JOIN ludia_users u ON p.admin_id = u.id ORDER BY p.created_at DESC");
    } else {
        $stmt = db()->prepare("SELECT * FROM ludia_patients WHERE admin_id = ? ORDER BY created_at DESC");
        $stmt->execute([$sess['user_id']]);
    }

    $patients = array_map('get_patient_with_visits', $stmt->fetchAll());
    respond(['success' => true, 'patients' => $patients]);
}

function handle_save_patient($in) {
    $sess = require_auth();
    $p = $in['patient'] ?? $in;

    $name = trim($p['name'] ?? '');
    if (!$name) respond(['error' => '이름을 입력해주세요.'], 400);

    $survey_json = json_encode($p['survey']     ?? [], JSON_UNESCAPED_UNICODE);
    $iris_json   = json_encode($p['irisPhotos'] ?? null, JSON_UNESCAPED_UNICODE);
    $id = $p['id'] ?? null;

    if ($id) {
        // Update — check ownership
        if ($sess['role'] !== 'super_admin') {
            $stmt = db()->prepare("SELECT admin_id FROM ludia_patients WHERE id = ? LIMIT 1");
            $stmt->execute([$id]);
            $row = $stmt->fetch();
            if (!$row || $row['admin_id'] !== $sess['user_id'])
                respond(['error' => '권한이 없습니다.'], 403);
        }
        db()->prepare("UPDATE ludia_patients SET name=?, phone=?, dob=?, gender=?, address=?, occupation=?, email=?, survey_data=?, iris_photos_data=?, updated_at=NOW() WHERE id=?")
           ->execute([$name, $p['phone']??'', $p['dob']??'', $p['gender']??'', $p['address']??'', $p['occupation']??'', $p['email']??'', $survey_json, $iris_json, $id]);
    } else {
        // Insert
        $id = 'p_' . gen_id();
        $stmt = db()->query("SELECT COUNT(*) AS cnt FROM ludia_patients");
        $cnt  = $stmt->fetch()['cnt'];
        $uid  = $p['uniqueId'] ?? ('LUD-' . str_pad($cnt + 1, 3, '0', STR_PAD_LEFT));

        db()->prepare("INSERT INTO ludia_patients (id, admin_id, admin_name, unique_id, name, phone, dob, gender, address, occupation, email, survey_data, iris_photos_data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())")
           ->execute([$id, $sess['user_id'], $sess['name'], $uid, $name, $p['phone']??'', $p['dob']??'', $p['gender']??'', $p['address']??'', $p['occupation']??'', $p['email']??'', $survey_json, $iris_json]);
    }

    respond(['success' => true, 'id' => $id]);
}

function handle_delete_patient($in) {
    $sess = require_auth();
    $pid = $in['id'] ?? '';
    if (!$pid) respond(['error' => 'id가 필요합니다.'], 400);

    if ($sess['role'] !== 'super_admin') {
        $stmt = db()->prepare("SELECT admin_id FROM ludia_patients WHERE id = ? LIMIT 1");
        $stmt->execute([$pid]);
        $row = $stmt->fetch();
        if (!$row || $row['admin_id'] !== $sess['user_id']) respond(['error' => '권한이 없습니다.'], 403);
    }
    db()->prepare("DELETE FROM ludia_visits  WHERE patient_id = ?")->execute([$pid]);
    db()->prepare("DELETE FROM ludia_patients WHERE id = ?")->execute([$pid]);
    respond(['success' => true]);
}

// ══════════════════════════════════════════════════════
//  VISITS
// ══════════════════════════════════════════════════════

function handle_save_visit($in) {
    $sess = require_auth();
    $pid   = $in['patient_id'] ?? '';
    $visit = $in['visit']      ?? $in;

    if (!$pid) respond(['error' => 'patient_id가 필요합니다.'], 400);

    $vid  = $visit['id'] ?? null;
    $date = !empty($visit['date']) ? $visit['date'] : date('Y-m-d H:i:s');
    $json = json_encode($visit, JSON_UNESCAPED_UNICODE);

    if ($vid) {
        db()->prepare("UPDATE ludia_visits SET visit_date=?, visit_data=? WHERE id=? AND patient_id=?")
           ->execute([$date, $json, $vid, $pid]);
    } else {
        $vid = 'v_' . gen_id();
        $visit['id'] = $vid;
        $json = json_encode($visit, JSON_UNESCAPED_UNICODE);
        db()->prepare("INSERT INTO ludia_visits (id, patient_id, admin_id, visit_date, visit_data, created_at) VALUES (?, ?, ?, ?, ?, NOW())")
           ->execute([$vid, $pid, $sess['user_id'], $date, $json]);
    }

    respond(['success' => true, 'id' => $vid]);
}

function handle_delete_visit($in) {
    require_auth();
    $vid = $in['id'] ?? '';
    if (!$vid) respond(['error' => 'id가 필요합니다.'], 400);
    db()->prepare("DELETE FROM ludia_visits WHERE id = ?")->execute([$vid]);
    respond(['success' => true]);
}

// ══════════════════════════════════════════════════════
//  INTAKE
// ══════════════════════════════════════════════════════

function handle_get_intake() {
    $sess = require_auth();

    if ($sess['role'] === 'super_admin') {
        $stmt = db()->query("SELECT * FROM ludia_intake ORDER BY created_at DESC");
    } else {
        $code = $sess['admin_code'] ?? '';
        $stmt = db()->prepare("SELECT * FROM ludia_intake WHERE admin_code = ? OR admin_id = ? ORDER BY created_at DESC");
        $stmt->execute([$code, $sess['user_id']]);
    }

    $items = array_map(function($item) {
        $data = json_decode($item['submission_data'] ?? '{}', true) ?? [];
        $data['id']          = $item['id'];
        $data['status']      = $item['status'];
        $data['adminCode']   = $item['admin_code'];
        $data['submittedAt'] = $item['created_at'];
        $data['patientId']   = $item['patient_id'] ?? null;
        $data['visitId']     = $item['visit_id']   ?? null;
        $data['adminMemo']   = $item['admin_memo'] ?? '';
        // photos는 크기가 크므로 목록에서는 존재 여부만 반환
        $photos = $item['admin_photos'] ?? '';
        $data['hasPhotos']   = !empty($photos) && $photos !== '{}' && $photos !== '{"left":"","right":""}';
        return $data;
    }, $stmt->fetchAll());

    respond(['success' => true, 'intake' => $items]);
}

function handle_save_intake($in) {
    // Public — no auth required
    $admin_code = $in['adminCode'] ?? $in['admin_code'] ?? '';
    $data = $in['data'] ?? $in;

    $id   = 'int_' . gen_id();
    $json = json_encode($data, JSON_UNESCAPED_UNICODE);

    $admin_id = null;
    if ($admin_code) {
        $stmt = db()->prepare("SELECT id FROM ludia_users WHERE admin_code = ? LIMIT 1");
        $stmt->execute([$admin_code]);
        $row = $stmt->fetch();
        if ($row) $admin_id = $row['id'];
    }

    db()->prepare("INSERT INTO ludia_intake (id, admin_code, admin_id, submission_data, status, created_at) VALUES (?, ?, ?, ?, 'new', NOW())")
       ->execute([$id, $admin_code, $admin_id, $json]);

    respond(['success' => true, 'id' => $id]);
}

function _intake_ensure_columns() {
    static $done = false;
    if ($done) return;
    $done = true;
    $cols = [
        "ALTER TABLE ludia_intake MODIFY COLUMN status ENUM('new','contacted','forwarded','diagnosing','done','report_ready','reject') NOT NULL DEFAULT 'new'",
        "ALTER TABLE ludia_intake ADD COLUMN IF NOT EXISTS admin_memo TEXT NULL",
        "ALTER TABLE ludia_intake ADD COLUMN IF NOT EXISTS admin_photos LONGTEXT NULL",
        "ALTER TABLE ludia_intake ADD COLUMN IF NOT EXISTS patient_id VARCHAR(64) NULL",
        "ALTER TABLE ludia_intake ADD COLUMN IF NOT EXISTS visit_id VARCHAR(64) NULL",
    ];
    foreach ($cols as $sql) { try { db()->exec($sql); } catch (\Exception $e) {} }
}

function handle_set_intake_status($in) {
    require_auth();
    $id     = $in['id']     ?? '';
    $status = $in['status'] ?? 'new';
    $allowed = ['new','contacted','forwarded','diagnosing','done','report_ready','reject'];
    if (!in_array($status, $allowed)) $status = 'new';
    _intake_ensure_columns();
    db()->prepare("UPDATE ludia_intake SET status=? WHERE id=?")->execute([$status, $id]);
    respond(['success' => true]);
}

function handle_forward_patient($in) {
    require_auth();
    $id         = $in['id']         ?? '';
    $memo       = $in['memo']       ?? '';
    $leftPhoto  = $in['leftPhoto']  ?? '';
    $rightPhoto = $in['rightPhoto'] ?? '';
    if (!$id) respond(['success' => false, 'error' => 'id required']);
    _intake_ensure_columns();
    $photos = json_encode(['left' => $leftPhoto, 'right' => $rightPhoto], JSON_UNESCAPED_UNICODE);
    db()->prepare("UPDATE ludia_intake SET admin_memo=?, admin_photos=?, status='forwarded' WHERE id=?")
       ->execute([$memo, $photos, $id]);
    respond(['success' => true]);
}

function handle_save_intake_memo($in) {
    require_auth();
    $id   = $in['id']   ?? '';
    $memo = $in['memo'] ?? '';
    if (!$id) respond(['success' => false]);
    _intake_ensure_columns();
    db()->prepare("UPDATE ludia_intake SET admin_memo=? WHERE id=?")->execute([$memo, $id]);
    respond(['success' => true]);
}

function handle_get_intake_photos($in) {
    require_auth();
    $id = $in['id'] ?? '';
    _intake_ensure_columns();
    $row = db()->prepare("SELECT admin_photos FROM ludia_intake WHERE id=? LIMIT 1");
    $row->execute([$id]);
    $data = $row->fetch();
    $photos = json_decode($data['admin_photos'] ?? '{}', true) ?? [];
    respond(['success' => true, 'photos' => $photos]);
}

function handle_deliver_report($in) {
    $sess = require_auth();
    $intake_id  = $in['intake_id']  ?? '';
    $patient_id = $in['patient_id'] ?? '';
    $visit_id   = $in['visit_id']   ?? '';
    if (!$intake_id) respond(['success' => false, 'error' => 'intake_id required']);
    _intake_ensure_columns();
    db()->prepare("UPDATE ludia_intake SET patient_id=?, visit_id=?, status='report_ready' WHERE id=?")
       ->execute([$patient_id, $visit_id, $intake_id]);

    if ($visit_id) {
        $row = db()->prepare("SELECT visit_data FROM ludia_visits WHERE id = ? AND patient_id = ?");
        $row->execute([$visit_id, $patient_id]);
        $vdata = $row->fetch();
        if ($vdata) {
            $visit = json_decode($vdata['visit_data'] ?? '{}', true) ?: [];
            $visit['reportBy'] = ['name' => $sess['name'], 'reportAt' => date('c')];
            db()->prepare("UPDATE ludia_visits SET visit_data=? WHERE id=? AND patient_id=?")
               ->execute([json_encode($visit, JSON_UNESCAPED_UNICODE), $visit_id, $patient_id]);
        }
    }

    respond(['success' => true]);
}

function handle_delete_intake($in) {
    require_auth();
    $id = $in['id'] ?? '';
    db()->prepare("DELETE FROM ludia_intake WHERE id=?")->execute([$id]);
    respond(['success' => true]);
}

// ══════════════════════════════════════════════════════
//  INVITE CODES
// ══════════════════════════════════════════════════════

function handle_create_invite_code() {
    $sess = require_auth();
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do {
        $code = 'INV-';
        for ($i = 0; $i < 6; $i++) $code .= $chars[random_int(0, strlen($chars) - 1)];
        $stmt = db()->prepare("SELECT code FROM ludia_invite_codes WHERE code=? LIMIT 1");
        $stmt->execute([$code]);
    } while ($stmt->fetch());

    db()->prepare("INSERT INTO ludia_invite_codes (code, admin_id, used, created_at) VALUES (?, ?, 0, NOW())")
       ->execute([$code, $sess['user_id']]);
    respond(['success' => true, 'code' => $code]);
}

function handle_list_invite_codes() {
    $sess = require_auth();
    if ($sess['role'] === 'super_admin') {
        $stmt = db()->query("SELECT * FROM ludia_invite_codes ORDER BY created_at DESC");
    } else {
        $stmt = db()->prepare("SELECT * FROM ludia_invite_codes WHERE admin_id=? ORDER BY created_at DESC");
        $stmt->execute([$sess['user_id']]);
    }
    respond(['success' => true, 'codes' => $stmt->fetchAll()]);
}

function handle_delete_invite_code($in) {
    require_auth();
    $code = $in['code'] ?? '';
    db()->prepare("DELETE FROM ludia_invite_codes WHERE code=? AND used=0")->execute([$code]);
    respond(['success' => true]);
}

// ══════════════════════════════════════════════════════
//  MEMBER VIEW
// ══════════════════════════════════════════════════════

function handle_get_my_patient() {
    $sess = require_auth();
    if ($sess['role'] !== 'member') respond(['error' => '회원만 접근 가능합니다.'], 403);

    $uid = $sess['linked_patient_uid'] ?? '';
    if (!$uid) respond(['patient' => null]);

    $stmt = db()->prepare("SELECT * FROM ludia_patients WHERE unique_id = ? LIMIT 1");
    $stmt->execute([$uid]);
    $patient = $stmt->fetch();
    if (!$patient) respond(['patient' => null]);

    respond(['success' => true, 'patient' => get_patient_with_visits($patient)]);
}

// ══════════════════════════════════════════════════════
//  MIGRATION (localStorage → MySQL)
// ══════════════════════════════════════════════════════

function handle_migrate($in) {
    $sess = require_auth();

    $migrated = ['users' => 0, 'patients' => 0, 'visits' => 0, 'intake' => 0];

    // Users
    foreach ($in['users'] ?? [] as $u) {
        if (($u['role'] ?? '') === 'super_admin') continue;
        $uid = $u['id'] ?? ('usr_' . gen_id());
        $stmt = db()->prepare("SELECT id FROM ludia_users WHERE id=? OR email=? LIMIT 1");
        $stmt->execute([$uid, $u['email'] ?? '']);
        if ($stmt->fetch()) continue;

        $admin_code = $u['adminCode'] ?? null;
        if ($admin_code) {
            $stmt = db()->prepare("SELECT id FROM ludia_users WHERE admin_code=? LIMIT 1");
            $stmt->execute([$admin_code]);
            if ($stmt->fetch()) $admin_code = null;
        }

        db()->prepare("INSERT IGNORE INTO ludia_users (id, name, email, phone, password_hash, role, admin_code, linked_patient_uid, linked_patient_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
           ->execute([$uid, $u['name']??'', $u['email']??'', $u['phone']??'', $u['password']??'',
                     $u['role']??'admin', $admin_code, $u['linkedPatientUniqueId']??null, $u['linkedPatientName']??null,
                     substr($u['createdAt']??'', 0, 19) ?: date('Y-m-d H:i:s')]);
        $migrated['users']++;
    }

    // Patients
    foreach ($in['records'] ?? [] as $r) {
        $pid = $r['id'] ?? ('p_' . gen_id());
        $stmt = db()->prepare("SELECT id FROM ludia_patients WHERE id=? LIMIT 1");
        $stmt->execute([$pid]);
        if (!$stmt->fetch()) {
            $admin_id = $r['createdBy'] ?? $sess['user_id'];
            $uid_val  = $r['uniqueId'] ?? '';
            // Avoid duplicate unique_id
            if ($uid_val) {
                $stmt2 = db()->prepare("SELECT id FROM ludia_patients WHERE unique_id=? LIMIT 1");
                $stmt2->execute([$uid_val]);
                if ($stmt2->fetch()) $uid_val = $uid_val . '_m';
            }
            db()->prepare("INSERT IGNORE INTO ludia_patients (id, admin_id, admin_name, unique_id, name, phone, dob, gender, address, occupation, email, survey_data, iris_photos_data, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
               ->execute([$pid, $admin_id, $r['createdByName']??'', $uid_val, $r['name']??'–', $r['phone']??'', $r['dob']??'', $r['gender']??'', $r['address']??'', $r['occupation']??'', $r['email']??'',
                         json_encode($r['survey']??[], JSON_UNESCAPED_UNICODE),
                         json_encode($r['irisPhotos']??null, JSON_UNESCAPED_UNICODE),
                         substr($r['createdAt']??'', 0, 19) ?: date('Y-m-d H:i:s')]);
            $migrated['patients']++;
        }

        foreach ($r['visits'] ?? [] as $v) {
            $vid = $v['id'] ?? ('v_' . gen_id());
            $stmt = db()->prepare("SELECT id FROM ludia_visits WHERE id=? LIMIT 1");
            $stmt->execute([$vid]);
            if ($stmt->fetch()) continue;
            $vdate = substr($v['date']??'', 0, 19) ?: date('Y-m-d H:i:s');
            db()->prepare("INSERT IGNORE INTO ludia_visits (id, patient_id, admin_id, visit_date, visit_data, created_at) VALUES (?,?,?,?,?,?)")
               ->execute([$vid, $pid, $r['createdBy']??$sess['user_id'], $vdate, json_encode($v, JSON_UNESCAPED_UNICODE), $vdate]);
            $migrated['visits']++;
        }
    }

    // Intake
    foreach ($in['intake'] ?? [] as $item) {
        $iid = $item['id'] ?? ('int_' . gen_id());
        $stmt = db()->prepare("SELECT id FROM ludia_intake WHERE id=? LIMIT 1");
        $stmt->execute([$iid]);
        if ($stmt->fetch()) continue;
        $status = in_array($item['status']??'', ['new','contacted','done','reject']) ? $item['status'] : 'new';
        $idate  = substr($item['submittedAt']??'', 0, 19) ?: date('Y-m-d H:i:s');
        db()->prepare("INSERT IGNORE INTO ludia_intake (id, admin_code, submission_data, status, created_at) VALUES (?,?,?,?,?)")
           ->execute([$iid, $item['adminCode']??'', json_encode($item, JSON_UNESCAPED_UNICODE), $status, $idate]);
        $migrated['intake']++;
    }

    respond(['success' => true, 'migrated' => $migrated]);
}

// ══════════════════════════════════════════════════════
//  RAG — CASES DB
// ══════════════════════════════════════════════════════

function _cases_ensure_table() {
    db()->exec("CREATE TABLE IF NOT EXISTS ludia_cases (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        patient_id  INT,
        visit_id    INT,
        intake_id   VARCHAR(64),
        path_number INT,
        axis1       FLOAT DEFAULT 0,
        axis2       FLOAT DEFAULT 0,
        axis3       FLOAT DEFAULT 0,
        axis4       FLOAT DEFAULT 0,
        axis5       FLOAT DEFAULT 0,
        iris_base   TEXT,
        surgery_ids TEXT,
        symptoms    TEXT,
        drug_cats   TEXT,
        extra_meds  TEXT,
        extra_symptoms TEXT,
        labels      TEXT,
        report_text LONGTEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (path_number),
        INDEX (intake_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    // 기존 테이블에 컬럼 추가 (마이그레이션)
    foreach (['intake_id VARCHAR(64)', 'labels TEXT'] as $col) {
        $colName = explode(' ', $col)[0];
        try { db()->exec("ALTER TABLE ludia_cases ADD COLUMN $col"); } catch(\Exception $e) {}
    }
}

function handle_save_case($in) {
    require_super();
    _cases_ensure_table();

    $axes  = $in['axes']  ?? [0,0,0,0,0];
    $db = db();
    $stmt = $db->prepare("INSERT INTO ludia_cases
        (patient_id, visit_id, intake_id, path_number, axis1, axis2, axis3, axis4, axis5,
         iris_base, surgery_ids, symptoms, drug_cats, extra_meds, extra_symptoms, labels, report_text)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    $stmt->execute([
        (int)($in['patient_id'] ?? 0),
        (int)($in['visit_id']   ?? 0),
        $in['intake_id']       ?? '',
        (int)($in['path_number'] ?? 0),
        (float)($axes[0] ?? 0),
        (float)($axes[1] ?? 0),
        (float)($axes[2] ?? 0),
        (float)($axes[3] ?? 0),
        (float)($axes[4] ?? 0),
        $in['iris_base']       ?? '',
        json_encode($in['surgery_ids']  ?? [], JSON_UNESCAPED_UNICODE),
        json_encode($in['symptoms']     ?? [], JSON_UNESCAPED_UNICODE),
        json_encode($in['drug_cats']    ?? [], JSON_UNESCAPED_UNICODE),
        $in['extra_meds']      ?? '',
        $in['extra_symptoms']  ?? '',
        json_encode($in['labels']       ?? [], JSON_UNESCAPED_UNICODE),
        $in['report_text']     ?? '',
    ]);
    respond(['success' => true, 'case_id' => $db->lastInsertId()]);
}

function handle_delete_case($in) {
    require_super();
    _cases_ensure_table();
    $id = (int)($in['case_id'] ?? 0);
    if (!$id) respond(['success' => false, 'error' => 'missing case_id']);
    db()->prepare("DELETE FROM ludia_cases WHERE id = ?")->execute([$id]);
    respond(['success' => true]);
}

function handle_delete_all_cases() {
    require_super();
    _cases_ensure_table();
    db()->exec("DELETE FROM ludia_cases");
    respond(['success' => true, 'deleted' => true]);
}

function handle_list_cases() {
    require_super();
    _cases_ensure_table();
    $rows = db()->query("SELECT id, patient_id, visit_id, path_number, axis1, axis2, axis3, axis4, axis5, symptoms, drug_cats, labels, created_at FROM ludia_cases ORDER BY id DESC LIMIT 200")->fetchAll(\PDO::FETCH_ASSOC);
    respond(['success' => true, 'cases' => $rows]);
}

function handle_get_similar_cases($in) {
    require_auth();
    _cases_ensure_table();

    $axes = $in['axes'] ?? [0,0,0,0,0];
    $a1 = (float)($axes[0]??0); $a2 = (float)($axes[1]??0);
    $a3 = (float)($axes[2]??0); $a4 = (float)($axes[3]??0);
    $a5 = (float)($axes[4]??0);
    $pathNum = (int)($in['path_number'] ?? 0);
    $limit   = min((int)($in['limit'] ?? 3), 10);

    // 최신 500건 안에서 거리 계산 (성능 보장)
    $rows = db()->query("SELECT * FROM ludia_cases ORDER BY id DESC LIMIT 500")->fetchAll();
    if (!$rows) { respond(['success' => true, 'cases' => []]); }

    // Manhattan distance — 같은 path_number 보너스
    foreach ($rows as &$row) {
        $dist = abs($row['axis1']-$a1) + abs($row['axis2']-$a2) + abs($row['axis3']-$a3)
              + abs($row['axis4']-$a4) + abs($row['axis5']-$a5);
        if ($row['path_number'] === $pathNum) $dist *= 0.5; // 같은 경로 우선
        $row['_dist'] = $dist;
    }
    usort($rows, fn($a,$b) => $a['_dist'] <=> $b['_dist']);
    $top = array_slice($rows, 0, $limit);

    // 리포트 전문은 제외하고 요약만 반환
    foreach ($top as &$r) {
        $r['surgery_ids'] = json_decode($r['surgery_ids'] ?? '[]', true);
        $r['symptoms']    = json_decode($r['symptoms']    ?? '[]', true);
        $r['drug_cats']   = json_decode($r['drug_cats']   ?? '[]', true);
        $r['report_preview'] = mb_substr($r['report_text'] ?? '', 0, 300);
        unset($r['report_text'], $r['_dist']);
    }
    respond(['success' => true, 'cases' => $top]);
}

// ══════════════════════════════════════════════════════
//  TAXONOMY — 증상/질병/수술 커스텀 태그 (전체 관리자 공통)
// ══════════════════════════════════════════════════════

function _taxonomy_ensure_table() {
    db()->exec("CREATE TABLE IF NOT EXISTS ludia_taxonomy (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        type        VARCHAR(20) NOT NULL,
        item_key    VARCHAR(255) NOT NULL,
        label       VARCHAR(255) NOT NULL,
        axis        TINYINT NULL,
        created_by  VARCHAR(64),
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_type_key (type, item_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    try { db()->exec("ALTER TABLE ludia_taxonomy ADD COLUMN IF NOT EXISTS color VARCHAR(20) NULL"); } catch (\Exception $e) {}
}

function handle_get_taxonomy() {
    require_auth();
    _taxonomy_ensure_table();
    $rows = db()->query("SELECT type, item_key AS `key`, label, axis, color FROM ludia_taxonomy ORDER BY created_at ASC")->fetchAll();
    $out = ['sx' => [], 'dx' => [], 'surgery' => [], 'iris_zone' => []];
    foreach ($rows as $r) {
        $r['axis'] = $r['axis'] !== null ? (int)$r['axis'] : null;
        if (isset($out[$r['type']])) $out[$r['type']][] = $r;
    }
    respond(['success' => true, 'taxonomy' => $out]);
}

function handle_add_taxonomy_item($in) {
    $sess = require_auth();
    _taxonomy_ensure_table();

    $type  = $in['type']  ?? '';
    $label = trim($in['label'] ?? '');
    $axis  = isset($in['axis']) && $in['axis'] !== '' ? max(1, min(5, (int)$in['axis'])) : null;
    $color = trim($in['color'] ?? '') ?: null;

    if (!in_array($type, ['sx', 'dx', 'surgery', 'iris_zone'])) respond(['error' => '올바르지 않은 타입입니다.'], 400);
    if (!$label) respond(['error' => '이름을 입력해주세요.'], 400);

    $key = $label; // 커스텀 항목은 라벨 자체를 key로 사용

    $stmt = db()->prepare("INSERT INTO ludia_taxonomy (type, item_key, label, axis, color, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE label = VALUES(label), color = VALUES(color)");
    $stmt->execute([$type, $key, $label, $axis, $color, $sess['user_id']]);

    respond(['success' => true, 'item' => ['key' => $key, 'label' => $label, 'axis' => $axis, 'color' => $color]]);
}

// ══════════════════════════════════════════════════════
//  IRIS GRID LABELS — 홍채 그리드 라벨링 (그리드 셀별 구역/유효성 태그)
// ══════════════════════════════════════════════════════

function _iris_grid_ensure_table() {
    db()->exec("CREATE TABLE IF NOT EXISTS ludia_iris_grid_labels (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        patient_id   VARCHAR(64) NOT NULL,
        visit_id     VARCHAR(64) NULL,
        eye          VARCHAR(10) NOT NULL,
        photo_index  INT NOT NULL DEFAULT 0,
        grid_rings   INT NOT NULL DEFAULT 6,
        grid_sectors INT NOT NULL DEFAULT 24,
        cells        LONGTEXT,
        created_by   VARCHAR(64),
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_photo (patient_id, visit_id, eye, photo_index)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
}

function handle_save_iris_grid_label($in) {
    $sess = require_auth();
    _iris_grid_ensure_table();

    $patient_id = $in['patient_id'] ?? '';
    $visit_id   = $in['visit_id']   ?? null;
    $eye        = $in['eye']        ?? '';
    $photo_idx  = (int)($in['photo_index'] ?? 0);
    $rings      = (int)($in['grid_rings']   ?? 6);
    $sectors    = (int)($in['grid_sectors'] ?? 24);
    $cells      = json_encode($in['cells'] ?? [], JSON_UNESCAPED_UNICODE);

    if (!$patient_id) respond(['error' => 'patient_id가 필요합니다.'], 400);
    if (!in_array($eye, ['left', 'right'])) respond(['error' => 'eye는 left/right여야 합니다.'], 400);

    $stmt = db()->prepare("INSERT INTO ludia_iris_grid_labels
        (patient_id, visit_id, eye, photo_index, grid_rings, grid_sectors, cells, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE grid_rings = VALUES(grid_rings), grid_sectors = VALUES(grid_sectors),
            cells = VALUES(cells), updated_at = NOW()");
    $stmt->execute([$patient_id, $visit_id, $eye, $photo_idx, $rings, $sectors, $cells, $sess['user_id']]);

    respond(['success' => true]);
}

function handle_get_iris_grid_labels($in) {
    require_auth();
    _iris_grid_ensure_table();

    $patient_id = $in['patient_id'] ?? '';
    if (!$patient_id) respond(['error' => 'patient_id가 필요합니다.'], 400);

    $stmt = db()->prepare("SELECT * FROM ludia_iris_grid_labels WHERE patient_id = ?");
    $stmt->execute([$patient_id]);
    $rows = array_map(function($r) {
        $r['cells'] = json_decode($r['cells'] ?? '[]', true);
        return $r;
    }, $stmt->fetchAll());

    respond(['success' => true, 'labels' => $rows]);
}

function handle_export_iris_grid_dataset() {
    require_super();
    _iris_grid_ensure_table();

    $rows = db()->query("SELECT * FROM ludia_iris_grid_labels")->fetchAll();
    $out = [];
    foreach ($rows as $r) {
        $pstmt = db()->prepare("SELECT iris_photos_data FROM ludia_patients WHERE id = ? LIMIT 1");
        $pstmt->execute([$r['patient_id']]);
        $prow = $pstmt->fetch();
        $irisPhotos = json_decode($prow['iris_photos_data'] ?? 'null', true) ?? [];
        $photoArr = $irisPhotos[$r['eye']] ?? null;
        $photoArr = is_array($photoArr) ? $photoArr : ($photoArr ? [$photoArr] : []);
        $image = $photoArr[(int)$r['photo_index']] ?? null;

        $out[] = [
            'case_id'      => 'GRID-' . $r['id'],
            'patient_id'   => $r['patient_id'],
            'visit_id'     => $r['visit_id'],
            'eye'          => $r['eye'],
            'grid_rings'   => (int)$r['grid_rings'],
            'grid_sectors' => (int)$r['grid_sectors'],
            'cells'        => json_decode($r['cells'] ?? '[]', true),
            'image_base64' => $image,
        ];
    }
    respond(['success' => true, 'cases' => $out]);
}
