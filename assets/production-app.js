(function () {
  "use strict";

  const config = window.TEACHER_PORTAL_CONFIG || {};
  const root = document.getElementById("appRoot");
  const state = {
    client: null,
    session: null,
    profile: null,
    membership: null,
    school: null,
    data: emptyData(),
    activeView: "overview",
    selectedDate: dateInTimezone(new Date(), "Europe/Kyiv"),
    calendarOffset: 0,
    selectedLessonId: null,
    notice: null,
    loading: false
  };

  document.addEventListener("click", handleClick);
  document.addEventListener("submit", handleSubmit);

  void initialize();

  function emptyData() {
    return {
      profiles: [],
      memberships: [],
      requests: [],
      subjects: [],
      teacherStudents: [],
      rates: [],
      lessons: [],
      lessonStudents: [],
      homework: [],
      homeworkStudents: [],
      submissions: [],
      attachments: [],
      ledger: []
    };
  }

  async function initialize() {
    if (!isConfigured()) {
      renderSetup();
      return;
    }
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      renderFatal("Не вдалося завантажити Supabase SDK. Перевір інтернет-з’єднання та онови сторінку.");
      return;
    }
    state.client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    const { data } = await state.client.auth.getSession();
    state.session = data.session;
    state.client.auth.onAuthStateChange((_event, session) => {
      state.session = session;
      void refreshContext();
    });
    await refreshContext();
  }

  function isConfigured() {
    return typeof config.supabaseUrl === "string"
      && config.supabaseUrl.startsWith("https://")
      && typeof config.supabaseAnonKey === "string"
      && config.supabaseAnonKey.length > 20;
  }

  async function refreshContext() {
    state.profile = null;
    state.membership = null;
    state.school = null;
    state.data = emptyData();
    state.selectedLessonId = null;

    if (!state.session) {
      renderAuth();
      return;
    }

    setLoading(true);
    try {
      const userId = state.session.user.id;
      const profileResult = await state.client.from("profiles").select("*").eq("id", userId).maybeSingle();
      if (profileResult.error && profileResult.error.code !== "PGRST116") throw profileResult.error;
      state.profile = profileResult.data || null;

      const membershipResult = await state.client
        .from("school_memberships")
        .select("id, school_id, role, status, schools(id, name, currency, timezone)")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });
      if (membershipResult.error) throw membershipResult.error;
      state.membership = (membershipResult.data || []).find((item) => item.status === "active") || null;

      if (!state.membership) {
        const requestResult = await state.client
          .from("registration_requests")
          .select("id, requested_role, status, created_at")
          .eq("user_id", userId)
          .maybeSingle();
        if (requestResult.error && requestResult.error.code !== "PGRST116") throw requestResult.error;
        renderOnboarding(requestResult.data || null);
        return;
      }

      state.school = state.membership.schools || { id: state.membership.school_id, name: config.schoolName || "Школа", currency: "UAH", timezone: "Europe/Kyiv" };
      await loadDashboardData();
      renderDashboard();
    } catch (error) {
      renderFatal(`Не вдалося завантажити дані: ${friendlyError(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadDashboardData() {
    const schoolId = state.membership.school_id;
    const role = state.membership.role;
    const [subjects, relations, lessons, homework, profiles, memberships] = await Promise.all([
      selectRows("subjects", (q) => q.eq("school_id", schoolId).order("name")),
      selectRows("teacher_students", (q) => q.eq("school_id", schoolId).eq("is_active", true)),
      selectRows("lessons", (q) => q.eq("school_id", schoolId).order("starts_at")),
      selectRows("homework", (q) => q.eq("school_id", schoolId).order("created_at", { ascending: false })),
      selectRows("profiles", (q) => q.order("full_name")),
      role === "admin" ? selectRows("school_memberships", (q) => q.eq("school_id", schoolId)) : Promise.resolve([])
    ]);

    state.data.subjects = subjects;
    state.data.teacherStudents = relations;
    state.data.lessons = lessons;
    state.data.homework = homework;
    state.data.profiles = profiles;
    state.data.memberships = memberships;

    const lessonIds = lessons.map((item) => item.id);
    const homeworkIds = homework.map((item) => item.id);
    state.data.lessonStudents = await selectRowsIn("lesson_students", "lesson_id", lessonIds);
    state.data.homeworkStudents = await selectRowsIn("homework_students", "homework_id", homeworkIds);
    state.data.submissions = await selectRowsIn("homework_submissions", "homework_student_id", state.data.homeworkStudents.map((item) => item.id));
    state.data.attachments = await selectRows("file_attachments", (q) => q.eq("school_id", schoolId).order("created_at", { ascending: false }));

    if (role === "admin") {
      const [requests, rates, ledger] = await Promise.all([
        selectRows("registration_requests", (q) => q.eq("status", "pending").order("created_at")),
        selectRows("student_rates", (q) => q.eq("school_id", schoolId).order("active_from", { ascending: false })),
        selectRows("wallet_ledger", (q) => q.eq("school_id", schoolId).order("created_at", { ascending: false }))
      ]);
      state.data.requests = requests;
      state.data.rates = rates;
      state.data.ledger = ledger;
    }
  }

  async function selectRows(table, modifier) {
    let query = state.client.from(table).select("*");
    if (modifier) query = modifier(query);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async function selectRowsIn(table, column, ids) {
    if (!ids.length) return [];
    return selectRows(table, (q) => q.in(column, ids));
  }

  function renderSetup() {
    root.innerHTML = shell(`
      <section class="auth-shell">
        <div class="auth-card wide-card">
          <div class="brand"><div class="brand-mark">TP</div><div><div class="brand-title">Teacher Portal</div><div class="brand-sub">Production setup</div></div></div>
          <h1>Потрібне підключення до Supabase</h1>
          <p class="muted">Вкажи URL і publishable/anon key нового staging-проєкту у файлі <code>assets/config.js</code>. Не додавай у браузер <code>service_role</code> key.</p>
          <div class="filebox"><strong>Порядок запуску:</strong><br>1. Запусти <code>supabase/production_schema.sql</code> у SQL Editor.<br>2. Вкажи конфігурацію.<br>3. Створи перший admin-акаунт через форму нижче.</div>
        </div>
      </section>
    `);
  }

  function renderAuth() {
    root.innerHTML = shell(`
      <section class="auth-shell">
        <div class="auth-card wide-card">
          <div class="brand"><div class="brand-mark">TP</div><div><div class="brand-title">${escape(config.schoolName || "Teacher Portal")}</div><div class="brand-sub">Кабінет школи</div></div></div>
          ${renderNotice()}
          <div class="auth-columns">
            <form id="loginForm" class="stack card plain-card">
              <h2>Вхід</h2>
              <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email" /></div>
              <div class="field"><label>Пароль</label><input name="password" type="password" required autocomplete="current-password" /></div>
              <button class="btn primary" type="submit">Увійти</button>
            </form>
            <form id="registerForm" class="stack card plain-card">
              <h2>Реєстрація</h2>
              <div class="field"><label>Ім’я та прізвище</label><input name="fullName" required /></div>
              <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email" /></div>
              <div class="field"><label>Пароль</label><input name="password" type="password" minlength="8" required autocomplete="new-password" /></div>
              <div class="field"><label>Я реєструюся як</label><select name="requestedRole"><option value="student">Учень</option><option value="teacher">Викладач</option></select></div>
              <button class="btn secondary" type="submit">Надіслати заявку</button>
              <div class="meta">Після реєстрації доступ підтверджує адміністратор.</div>
            </form>
          </div>
        </div>
      </section>
    `);
  }

  function renderOnboarding(request) {
    const userName = state.session.user.email || "";
    root.innerHTML = shell(`
      <section class="auth-shell">
        <div class="auth-card wide-card">
          <div class="brand"><div class="brand-mark">TP</div><div><div class="brand-title">Teacher Portal</div><div class="brand-sub">${escape(userName)}</div></div></div>
          ${renderNotice()}
          ${request ? `
            <h1>Заявка очікує підтвердження</h1>
            <p class="muted">Адміністратор має підтвердити роль: <strong>${request.requested_role === "teacher" ? "викладач" : "учень"}</strong>.</p>
          ` : `
            <div class="auth-columns">
              <form id="requestMembershipForm" class="stack card plain-card">
                <h2>Приєднатися до школи</h2>
                <div class="field"><label>Ім’я та прізвище</label><input name="fullName" value="${escapeAttr(state.profile?.full_name || "")}" required /></div>
                <div class="field"><label>Роль</label><select name="requestedRole"><option value="student">Учень</option><option value="teacher">Викладач</option></select></div>
                <button class="btn primary" type="submit">Надіслати заявку</button>
              </form>
              <form id="bootstrapSchoolForm" class="stack card plain-card">
                <h2>Створити першу школу</h2>
                <p class="muted">Це виконує лише перший власник нового Supabase-проєкту.</p>
                <div class="field"><label>Назва школи</label><input name="schoolName" value="${escapeAttr(config.schoolName || "Моя школа")}" required /></div>
                <div class="field"><label>Ім’я адміністратора</label><input name="fullName" value="${escapeAttr(state.profile?.full_name || "")}" required /></div>
                <button class="btn secondary" type="submit">Створити школу та admin-доступ</button>
              </form>
            </div>
          `}
          <button class="btn small secondary" type="button" data-action="logout">Вийти</button>
        </div>
      </section>
    `);
  }

  function renderFatal(message) {
    root.innerHTML = shell(`<section class="auth-shell"><div class="auth-card"><h1>Потрібна увага</h1><div class="msg error">${escape(message)}</div></div></section>`);
  }

  function shell(content) {
    return `<main class="production-app">${content}</main>`;
  }

  async function handleClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    try {
      if (action === "logout") {
        await state.client.auth.signOut();
        return;
      }
      if (action === "set-view") {
        state.activeView = target.dataset.view || "overview";
        renderDashboard();
        return;
      }
      if (action === "calendar-prev") {
        state.calendarOffset -= 1;
        renderDashboard();
        return;
      }
      if (action === "calendar-next") {
        state.calendarOffset += 1;
        renderDashboard();
        return;
      }
      if (action === "calendar-today") {
        state.calendarOffset = 0;
        state.selectedDate = isoDate(new Date());
        state.selectedLessonId = null;
        renderDashboard();
        return;
      }
      if (action === "select-date") {
        state.selectedDate = target.dataset.date;
        state.selectedLessonId = null;
        renderDashboard();
        return;
      }
      if (action === "select-lesson") {
        state.selectedLessonId = target.dataset.lessonId || null;
        renderDashboard();
        return;
      }
      if (action === "approve-request") {
        await approveRequest(target.dataset.requestId);
        return;
      }
      if (action === "remove-assignment") {
        if (!confirm("Прибрати цього учня зі списку викладача?")) return;
        const { error } = await state.client.from("teacher_students").delete().eq("id", target.dataset.relationId);
        if (error) throw error;
        state.notice = success("Зв’язок викладача й учня прибрано.");
        await refreshContext();
        return;
      }
      if (action === "suspend-user" || action === "activate-user") {
        await manageAdminUser({ action: action === "suspend-user" ? "suspend" : "activate", userId: target.dataset.userId });
        return;
      }
      if (action === "delete-user") {
        if (!confirm("Видалити акаунт назавжди? Уроки та файли, пов’язані з ним, теж стануть недоступними.")) return;
        await manageAdminUser({ action: "delete", userId: target.dataset.userId });
        return;
      }
      if (action === "download-file") {
        await downloadAttachment(target.dataset.fileId);
        return;
      }
      if (action === "upload-lesson-files") {
        const form = target.closest("form");
        if (!form) return;
        await uploadInputFiles(form, { lesson_id: target.dataset.lessonId });
        state.notice = success("Матеріали до заняття завантажено.");
        await refreshContext();
        return;
      }
      if (action === "mark-homework-reviewed") {
        await updateHomeworkStudent(target.dataset.homeworkStudentId, { status: "reviewed", reviewed_at: new Date().toISOString() });
        return;
      }
      if (action === "delete-lesson") {
        if (!confirm("Видалити це заняття?")) return;
        const { error } = await state.client.from("lessons").delete().eq("id", target.dataset.lessonId);
        if (error) throw error;
        state.notice = success("Заняття видалено.");
        await refreshContext();
      }
    } catch (error) {
      state.notice = failure(friendlyError(error));
      renderCurrent();
    }
  }

  async function handleSubmit(event) {
    const form = event.target;
    if (!form.id) return;
    event.preventDefault();
    try {
      if (form.id === "loginForm") await login(form);
      if (form.id === "registerForm") await register(form);
      if (form.id === "requestMembershipForm") await requestMembership(form);
      if (form.id === "bootstrapSchoolForm") await bootstrapSchool(form);
      if (form.id === "createSubjectForm") await createSubject(form);
      if (form.id === "assignTeacherStudentForm") await assignTeacherStudent(form);
      if (form.id === "createRateForm") await createRate(form);
      if (form.id === "createLessonForm") await createLesson(form);
      if (form.id === "lessonStatusForm") await setLessonStatus(form);
      if (form.id === "createHomeworkForm") await createHomework(form);
      if (form.id === "recordPaymentForm") await recordPayment(form);
      if (form.id === "submitHomeworkForm") await submitHomework(form);
      if (form.id === "feedbackForm") await sendFeedback(form);
      if (form.id === "adminCreateUserForm") await createAdminUser(form);
      if (form.id === "changeUserRoleForm") await changeUserRole(form);
    } catch (error) {
      state.notice = failure(friendlyError(error));
      renderCurrent();
    }
  }

  async function login(form) {
    const { error } = await state.client.auth.signInWithPassword({
      email: value(form, "email"),
      password: value(form, "password")
    });
    if (error) throw error;
    state.notice = success("Вхід виконано.");
  }

  async function register(form) {
    const email = value(form, "email");
    const password = value(form, "password");
    const fullName = value(form, "fullName");
    const requestedRole = value(form, "requestedRole");
    const { data, error } = await state.client.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, requested_role: requestedRole } }
    });
    if (error) throw error;
    if (data.session) {
      const { error: requestError } = await state.client.rpc("request_membership", { p_full_name: fullName, p_requested_role: requestedRole });
      if (requestError) throw requestError;
      state.notice = success("Заявку створено. Очікуй підтвердження адміністратора.");
    } else {
      state.notice = success("Перевір email, підтверди адресу, потім увійди та надішли заявку.");
      renderAuth();
    }
  }

  async function requestMembership(form) {
    const { error } = await state.client.rpc("request_membership", {
      p_full_name: value(form, "fullName"),
      p_requested_role: value(form, "requestedRole")
    });
    if (error) throw error;
    state.notice = success("Заявку надіслано адміністратору.");
    await refreshContext();
  }

  async function bootstrapSchool(form) {
    const { error } = await state.client.rpc("bootstrap_school", {
      p_school_name: value(form, "schoolName"),
      p_full_name: value(form, "fullName")
    });
    if (error) throw error;
    state.notice = success("Школу створено. Ти маєш admin-доступ.");
    await refreshContext();
  }

  async function approveRequest(requestId) {
    const { error } = await state.client.rpc("approve_registration", {
      p_request_id: requestId,
      p_school_id: state.school.id
    });
    if (error) throw error;
    state.notice = success("Заявку підтверджено.");
    await refreshContext();
  }

  async function createSubject(form) {
    const payload = {
      school_id: state.school.id,
      name: value(form, "name"),
      color: value(form, "color") || "#0f766e",
      default_duration_minutes: Number(value(form, "duration")) || 60
    };
    const { error } = await state.client.from("subjects").insert(payload);
    if (error) throw error;
    state.notice = success("Предмет додано.");
    await refreshContext();
  }

  async function assignTeacherStudent(form) {
    const { error } = await state.client.from("teacher_students").upsert({
      school_id: state.school.id,
      teacher_id: value(form, "teacherId"),
      student_id: value(form, "studentId"),
      is_active: true
    }, { onConflict: "school_id,teacher_id,student_id" });
    if (error) throw error;
    state.notice = success("Учня прив’язано до викладача.");
    await refreshContext();
  }

  async function createRate(form) {
    const price = wholeUah(value(form, "lessonPrice"));
    const payout = wholeUah(value(form, "teacherPayout"));
    const { error } = await state.client.from("student_rates").insert({
      school_id: state.school.id,
      student_id: value(form, "studentId"),
      teacher_id: value(form, "teacherId") || null,
      subject_id: value(form, "subjectId") || null,
      lesson_price_uah: price,
      teacher_payout_uah: payout,
      active_from: value(form, "activeFrom") || isoDate(new Date())
    });
    if (error) throw error;
    state.notice = success("Тариф збережено.");
    await refreshContext();
  }

  async function createLesson(form) {
    const studentIds = values(form, "studentIds");
    const startsAt = new Date(value(form, "startsAt"));
    const endsAt = new Date(value(form, "endsAt"));
    const { data, error } = await state.client.rpc("create_lesson", {
      p_school_id: state.school.id,
      p_subject_id: value(form, "subjectId"),
      p_title: value(form, "title"),
      p_starts_at: startsAt.toISOString(),
      p_ends_at: endsAt.toISOString(),
      p_student_ids: studentIds,
      p_meeting_url: value(form, "meetingUrl"),
      p_location_text: value(form, "location")
    });
    if (error) throw error;
    state.selectedLessonId = data;
    state.selectedDate = isoDate(startsAt);
    state.notice = success("Заняття створено. Ціну для кожного учня зафіксовано.");
    await refreshContext();
  }

  async function setLessonStatus(form) {
    const { error } = await state.client.rpc("set_lesson_status", {
      p_lesson_id: value(form, "lessonId"),
      p_status: value(form, "status"),
      p_note: value(form, "teacherNote")
    });
    if (error) throw error;
    state.notice = success("Статус заняття оновлено. За потреби фінансовий запис створено автоматично.");
    await refreshContext();
  }

  async function createHomework(form) {
    const lessonId = value(form, "lessonId") || null;
    const selectedLesson = lessonId ? lessonById(lessonId) : null;
    const studentIds = selectedLesson ? lessonStudents(selectedLesson.id).map((row) => row.student_id) : values(form, "studentIds");
    const { data, error } = await state.client.rpc("create_homework", {
      p_school_id: state.school.id,
      p_lesson_id: lessonId,
      p_title: value(form, "title"),
      p_description: value(form, "description"),
      p_deadline_at: value(form, "deadline") ? new Date(value(form, "deadline")).toISOString() : null,
      p_student_ids: studentIds
    });
    if (error) throw error;
    await uploadInputFiles(form, { homework_id: data });
    state.notice = success("Домашнє завдання опубліковано.");
    await refreshContext();
  }

  async function recordPayment(form) {
    const amount = wholeUah(value(form, "amount"));
    if (amount <= 0) throw new Error("Сума оплати має бути більшою за нуль.");
    const { error } = await state.client.from("wallet_ledger").insert({
      school_id: state.school.id,
      student_id: value(form, "studentId"),
      teacher_id: state.session.user.id,
      kind: "payment",
      amount_uah: amount,
      teacher_payout_uah: 0,
      note: value(form, "note"),
      created_by: state.session.user.id
    });
    if (error) throw error;
    state.notice = success("Оплату внесено у фінансовий журнал.");
    await refreshContext();
  }

  async function submitHomework(form) {
    const homeworkStudentId = value(form, "homeworkStudentId");
    const { data, error } = await state.client.rpc("submit_homework", {
      p_homework_student_id: homeworkStudentId,
      p_body: value(form, "body")
    });
    if (error) throw error;
    await uploadInputFiles(form, { submission_id: data });
    state.notice = success("Відповідь на домашнє завдання надіслано.");
    await refreshContext();
  }

  async function sendFeedback(form) {
    const homeworkStudentId = value(form, "homeworkStudentId");
    const status = value(form, "status");
    const { error } = await state.client.from("homework_students").update({
      status,
      teacher_comment: value(form, "comment"),
      grade: value(form, "grade") || null,
      reviewed_at: new Date().toISOString()
    }).eq("id", homeworkStudentId);
    if (error) throw error;
    await uploadInputFiles(form, { homework_student_id: homeworkStudentId });
    state.notice = success("Зворотний зв’язок збережено.");
    await refreshContext();
  }

  async function createAdminUser(form) {
    const password = value(form, "password");
    if (password.length < 8) throw new Error("Пароль має містити щонайменше 8 символів.");
    await manageAdminUser({
      action: "create",
      fullName: value(form, "fullName"),
      email: value(form, "email"),
      password,
      role: value(form, "role")
    });
  }

  async function changeUserRole(form) {
    await manageAdminUser({ action: "change_role", userId: value(form, "userId"), role: value(form, "role") });
  }

  async function manageAdminUser(payload) {
    const { data, error } = await state.client.functions.invoke("admin-users", {
      body: { ...payload, schoolId: state.school.id }
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    state.notice = success(data?.message || "Зміни доступу збережено.");
    await refreshContext();
  }

  function renderDashboard() {
    const role = state.membership.role;
    const navigation = role === "admin"
      ? [["overview", "Огляд"], ["people", "Люди"], ["subjects", "Предмети і тарифи"], ["finance", "Фінанси"]]
      : role === "teacher"
        ? [["calendar", "Календар"], ["students", "Мої учні"], ["homework", "Домашні"], ["payments", "Оплати"]]
        : [["today", "Сьогодні"], ["calendar", "Календар"], ["homework", "Домашні"]];
    if (!navigation.some(([view]) => view === state.activeView)) state.activeView = navigation[0][0];

    root.innerHTML = shell(`
      <section class="school-shell">
        <header class="school-header">
          <div class="container school-header-inner">
            <div class="brand"><div class="brand-mark">TP</div><div><div class="brand-title">${escape(state.school.name)}</div><div class="brand-sub">${roleTitle(role)} • ${escape(state.profile?.full_name || state.session.user.email)}</div></div></div>
            <button type="button" class="btn small secondary" data-action="logout">Вийти</button>
          </div>
        </header>
        <div class="container school-layout">
          <aside class="school-nav">
            ${navigation.map(([view, label]) => `<button class="nav-item ${state.activeView === view ? "active" : ""}" type="button" data-action="set-view" data-view="${view}">${label}</button>`).join("")}
          </aside>
          <section class="school-content">
            ${renderNotice()}
            ${role === "admin" ? renderAdminView() : ""}
            ${role === "teacher" ? renderTeacherView() : ""}
            ${role === "student" ? renderStudentView() : ""}
          </section>
        </div>
      </section>
    `);
  }

  function renderAdminView() {
    if (state.activeView === "overview") return renderAdminOverview();
    if (state.activeView === "people") return renderPeople();
    if (state.activeView === "subjects") return renderSubjectsAndRates();
    return renderFinance();
  }

  function renderAdminOverview() {
    const teachers = activeMembers("teacher");
    const students = activeMembers("student");
    const balances = walletBalances();
    const totalBalance = Object.values(balances).reduce((sum, item) => sum + item.balance, 0);
    const month = monthKey(new Date());
    const chargedThisMonth = state.data.ledger.filter((row) => row.kind === "lesson_charge" && row.created_at.startsWith(month) && row.status === "confirmed").reduce((sum, row) => sum + Math.abs(row.amount_uah), 0);
    return `
      <div class="page-heading"><div><p class="eyebrow">Адміністрування</p><h1>Огляд школи</h1><p class="muted">Ключові показники без зайвої бухгалтерії.</p></div></div>
      <div class="metric-grid">
        ${metricCard("Активні учні", students.length, "Наразі мають доступ")}
        ${metricCard("Активні викладачі", teachers.length, "Можна призначати учнів")}
        ${metricCard("Заявки", state.data.requests.length, "Очікують рішення")}
        ${metricCard("Баланс учнів", money(totalBalance), "Сумарний передплачений баланс")}
        ${metricCard("Списано цього місяця", money(chargedThisMonth), "Проведені та платні скасування")}
      </div>
      <div class="card"><h2>Найближчі заняття</h2>${renderLessonFeed(nextLessons(8))}</div>
    `;
  }

  function renderPeople() {
    const teachers = activeMembers("teacher");
    const students = activeMembers("student");
    return `
      <div class="page-heading"><div><p class="eyebrow">Доступ і групи</p><h1>Люди</h1><p class="muted">Адміністратор єдиний, хто призначає викладачів учням.</p></div></div>
      <div class="work-grid">
        <div class="card"><h2>Нові заявки</h2>
          <div class="list">${state.data.requests.length ? state.data.requests.map((item) => `
            <div class="item"><div class="item-head"><div><p class="item-title">${escape(item.full_name)}</p><div class="meta">${item.requested_role === "teacher" ? "Викладач" : "Учень"}</div></div><button class="btn small primary" data-action="approve-request" data-request-id="${item.id}">Підтвердити</button></div></div>
          `).join("") : empty("Нових заявок немає.")}</div>
        </div>
        <div class="card"><h2>Призначити викладача учню</h2>
          <form id="assignTeacherStudentForm" class="stack">
            ${selectField("teacherId", "Викладач", teachers, true)}
            ${selectField("studentId", "Учень", students, true)}
            <button class="btn primary" type="submit">Прив’язати</button>
          </form>
        </div>
      </div>
      <div class="work-grid">
        <div class="card"><h2>Створити акаунт</h2><p class="muted">Новий користувач отримає активний доступ одразу. Адміністратора може створити лише чинний адміністратор.</p><form id="adminCreateUserForm" class="stack"><div class="field"><label>Ім’я та прізвище</label><input name="fullName" required /></div><div class="field"><label>Email</label><input name="email" type="email" required /></div><div class="field"><label>Тимчасовий пароль</label><input name="password" type="password" minlength="8" required /></div><div class="field"><label>Роль</label><select name="role"><option value="student">Учень</option><option value="teacher">Викладач</option><option value="admin">Адміністратор</option></select></div><button class="btn primary" type="submit">Створити акаунт</button></form></div>
        <div class="card"><h2>Доступи</h2><p class="muted">Призупинення зберігає історію, а видалення прибирає акаунт остаточно.</p><div class="list">${state.data.memberships.filter((member) => member.status === "suspended").map((member) => `<div class="item"><div><p class="item-title">${escape(nameOf(member.user_id))}</p><div class="meta">${escape(roleTitle(member.role))} · доступ призупинено</div></div><button class="btn small secondary" type="button" data-action="activate-user" data-user-id="${member.user_id}">Відновити</button></div>`).join("") || empty("Призупинених акаунтів немає.")}</div></div>
      </div>
      <div class="card"><h2>Активні зв’язки</h2><div class="relation-list">${state.data.teacherStudents.map((relation) => `<div class="item"><strong>${escape(nameOf(relation.teacher_id))}</strong><span>викладає</span><strong>${escape(nameOf(relation.student_id))}</strong><button class="btn small secondary" type="button" data-action="remove-assignment" data-relation-id="${relation.id}">Прибрати</button></div>`).join("") || empty("Ще немає призначень.")}</div></div>
      <div class="work-grid"><div class="card"><h2>Викладачі</h2>${renderPeopleList(teachers)}</div><div class="card"><h2>Учні</h2>${renderPeopleList(students)}</div></div>
    `;
  }

  function renderSubjectsAndRates() {
    const teachers = activeMembers("teacher");
    const students = activeMembers("student");
    return `
      <div class="page-heading"><div><p class="eyebrow">Навчання і тарифи</p><h1>Предмети та ціни</h1><p class="muted">Ціна для учня і виплата викладачу зберігаються окремо.</p></div></div>
      <div class="work-grid">
        <div class="card"><h2>Новий предмет</h2><form id="createSubjectForm" class="stack"><div class="field"><label>Назва</label><input name="name" placeholder="Наприклад, Математика" required /></div><div class="field"><label>Колір у календарі</label><input name="color" type="color" value="#0f766e" /></div><div class="field"><label>Тривалість, хв</label><input name="duration" type="number" min="15" max="240" value="60" /></div><button class="btn primary" type="submit">Додати предмет</button></form></div>
        <div class="card"><h2>Новий тариф</h2><form id="createRateForm" class="stack">
          ${selectField("studentId", "Учень", students, true)}
          ${selectField("teacherId", "Викладач", teachers, false, "")}
          ${subjectSelect("subjectId", "Предмет", false, "")}
          <div class="two-fields"><div class="field"><label>Ціна уроку, грн</label><input name="lessonPrice" type="number" min="0" step="1" required /></div><div class="field"><label>Виплата викладачу, грн</label><input name="teacherPayout" type="number" min="0" step="1" required /></div></div>
          <div class="field"><label>Діє з</label><input name="activeFrom" type="date" value="${isoDate(new Date())}" required /></div><button class="btn primary" type="submit">Зберегти тариф</button>
        </form></div>
      </div>
      <div class="card"><h2>Предмети</h2><div class="chip-row">${state.data.subjects.map((item) => `<span class="subject-chip"><i style="background:${escapeAttr(item.color)}"></i>${escape(item.name)} · ${item.default_duration_minutes} хв</span>`).join("") || empty("Спочатку додай хоча б один предмет.")}</div></div>
      <div class="card"><h2>Історія тарифів</h2><div class="list">${state.data.rates.map((rate) => `<div class="item"><div class="item-head"><div><p class="item-title">${escape(nameOf(rate.student_id))}</p><div class="meta">${escape(rate.teacher_id ? nameOf(rate.teacher_id) : "Усі викладачі")} · ${escape(rate.subject_id ? subjectName(rate.subject_id) : "Усі предмети")}</div></div><strong>${money(rate.lesson_price_uah)} / виплата ${money(rate.teacher_payout_uah)}</strong></div></div>`).join("") || empty("Тарифів ще немає.")}</div></div>
    `;
  }

  function renderFinance() {
    const balances = walletBalances();
    const teacherDaily = teacherDailyTotals();
    return `
      <div class="page-heading"><div><p class="eyebrow">Фінанси</p><h1>Гаманці та виплати</h1><p class="muted">Баланс обчислюється тільки з журналу операцій.</p></div></div>
      <div class="work-grid"><div class="card"><h2>Баланс учнів</h2><div class="list">${activeMembers("student").map((student) => { const entry = balances[student.user_id] || { balance: 0, paid: 0, spent: 0 }; return `<div class="item"><div class="item-head"><div><p class="item-title">${escape(nameOf(student.user_id))}</p><div class="meta">Оплачено ${money(entry.paid)} · списано ${money(entry.spent)}</div></div><strong class="${entry.balance < 0 ? "amount-negative" : "amount-positive"}">${money(entry.balance)}</strong></div></div>`; }).join("") || empty("Немає учнів.")}</div></div>
      <div class="card"><h2>Виплати викладачам за днями</h2><div class="list">${teacherDaily.map((row) => `<div class="item"><div class="item-head"><div><p class="item-title">${escape(row.date)} · ${escape(nameOf(row.teacherId))}</p><div class="meta">За проведені або платно скасовані уроки</div></div><strong>${money(row.total)}</strong></div></div>`).join("") || empty("Ще немає нарахувань.")}</div></div></div>
      <div class="card"><h2>Останні операції</h2><div class="list">${state.data.ledger.slice(0, 30).map((row) => `<div class="item"><div class="item-head"><div><p class="item-title">${escape(nameOf(row.student_id))} · ${ledgerLabel(row.kind)}</p><div class="meta">${formatDateTime(row.created_at)} · ${escape(row.note || "Без коментаря")}</div></div><strong class="${row.amount_uah >= 0 ? "amount-positive" : "amount-negative"}">${signedMoney(row.amount_uah)}</strong></div></div>`).join("") || empty("Операцій ще немає.")}</div></div>
    `;
  }

  function renderTeacherView() {
    if (state.activeView === "students") return renderTeacherStudents();
    if (state.activeView === "homework") return renderTeacherHomework();
    if (state.activeView === "payments") return renderTeacherPayments();
    return renderTeacherCalendar();
  }

  function renderTeacherCalendar() {
    const lessons = state.data.lessons.filter((lesson) => lesson.teacher_id === state.session.user.id);
    const selected = selectedLesson();
    const ownStudents = teacherStudents();
    const todayLessons = lessons.filter((lesson) => localDate(lesson.starts_at) === isoDate(new Date()));
    return `
      <div class="page-heading"><div><p class="eyebrow">Мій розклад</p><h1>Календар викладача</h1><p class="muted">Створи заняття, відміть його статус і працюй з домашніми без переходів між системами.</p></div></div>
      <div class="metric-grid">${metricCard("Сьогодні", todayLessons.length, "занять")}${metricCard("Мої учні", ownStudents.length, "активних")}${metricCard("Заплановано", lessons.filter((item) => item.status === "planned").length, "у розкладі")}${metricCard("На перевірці", teacherHomeworkStudents().filter((item) => item.status === "submitted").length, "робіт")}</div>
      <div class="calendar-workspace">
        <div class="card calendar-column"><div class="calendar-actions"><h2>Календар</h2><button class="btn small secondary" data-action="calendar-today">Сьогодні</button></div>${renderCalendar(lessons)}</div>
        <div class="card day-column"><h2>${formatDate(state.selectedDate)}</h2><div class="list">${renderLessonCards(dayLessons(lessons), true)}</div><div class="filebox"><strong>Вільні вікна</strong><div class="meta">${freeSlots(dayLessons(lessons)).join(", ") || "На цей день вільних годин у робочому діапазоні немає."}</div></div></div>
      </div>
      <div class="work-grid"><div class="card"><h2>Нове заняття</h2>${renderLessonForm(ownStudents)}</div><div class="card"><h2>Картка заняття</h2>${selected ? renderLessonPanel(selected) : empty("Обери заняття в списку дня, щоб змінити статус, додати файл або домашнє.")}</div></div>
    `;
  }

  function renderTeacherStudents() {
    const students = teacherStudents();
    return `
      <div class="page-heading"><div><p class="eyebrow">Моя група</p><h1>Учні</h1><p class="muted">Тут відображаються лише учні, яких закріпив адміністратор.</p></div></div>
      <div class="card"><div class="list">${students.map((student) => {
        const upcoming = state.data.lessons.filter((lesson) => lesson.teacher_id === state.session.user.id && lessonStudents(lesson.id).some((row) => row.student_id === student.id) && new Date(lesson.starts_at) >= new Date()).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
        const submitted = teacherHomeworkStudents().filter((row) => row.student_id === student.id && row.status === "submitted").length;
        return `<div class="item"><div class="item-head"><div><p class="item-title">${escape(student.full_name)}</p><div class="meta">Наступний урок: ${upcoming ? escape(formatDateTime(upcoming.starts_at)) + " · " + escape(subjectName(upcoming.subject_id)) : "не заплановано"}</div><div class="meta">Робіт на перевірці: ${submitted}</div></div><span class="role-badge role-student">Учень</span></div></div>`;
      }).join("") || empty("Адміністратор ще не призначив тобі учнів.")}</div></div>
    `;
  }

  function renderTeacherHomework() {
    const tasks = state.data.homework.filter((task) => task.teacher_id === state.session.user.id);
    const selected = selectedLesson();
    return `
      <div class="page-heading"><div><p class="eyebrow">Перевірка</p><h1>Домашні завдання</h1><p class="muted">Публікуй завдання, дивись відповіді й повертай роботу на доопрацювання.</p></div></div>
      <div class="work-grid"><div class="card"><h2>Нове домашнє</h2>${renderHomeworkForm(selected)}</div><div class="card"><h2>На перевірці</h2>${renderTeacherHomeworkReview(tasks)}</div></div>
    `;
  }

  function renderTeacherPayments() {
    const students = teacherStudents();
    return `
      <div class="page-heading"><div><p class="eyebrow">Оплати</p><h1>Зафіксувати оплату</h1><p class="muted">Ти вносиш факт оплати. Повний гаманець і звіти бачить адміністратор.</p></div></div>
      <div class="work-grid"><div class="card"><h2>Нова оплата</h2><form id="recordPaymentForm" class="stack">${selectField("studentId", "Учень", students.map((s) => ({ user_id: s.id })), true)}<div class="field"><label>Сума, грн</label><input name="amount" type="number" step="1" min="1" required /></div><div class="field"><label>Коментар</label><textarea name="note" placeholder="Наприклад: оплата за вересень готівкою"></textarea></div><button class="btn primary" type="submit">Внести оплату</button></form></div><div class="card"><h2>Що відбувається після збереження</h2><div class="process-note"><strong>1.</strong> Оплата додається до фінансового журналу.<br><strong>2.</strong> Адміністратор бачить баланс учня.<br><strong>3.</strong> Проведені уроки списуються автоматично за встановленим тарифом.</div></div></div>
    `;
  }

  function renderStudentView() {
    if (state.activeView === "calendar") return renderStudentCalendar();
    if (state.activeView === "homework") return renderStudentHomework();
    return renderStudentToday();
  }

  function renderStudentToday() {
    const lessons = myLessons();
    const tasks = myHomeworkStudents();
    const today = isoDate(new Date());
    const todayLessons = lessons.filter((lesson) => localDate(lesson.starts_at) === today);
    const pendingTasks = tasks.filter((task) => task.status !== "reviewed");
    const overdue = tasks.filter((task) => { const homework = homeworkById(task.homework_id); return homework?.deadline_at && homework.deadline_at < new Date().toISOString() && task.status === "not_started"; });
    return `
      <div class="page-heading"><div><p class="eyebrow">Мій день</p><h1>Навчальний план</h1><p class="muted">Уроки, домашні та коментарі викладача в одному місці.</p></div></div>
      <div class="metric-grid">${metricCard("Уроків сьогодні", todayLessons.length, "перевір календар")}${metricCard("Активні домашні", pendingTasks.length, "потрібна дія")}${metricCard("Прострочено", overdue.length, "варто здати")}${metricCard("Матеріали", state.data.attachments.length, "доступних файлів")}</div>
      <div class="work-grid"><div class="card"><h2>Сьогодні</h2>${renderLessonFeed(todayLessons)}</div><div class="card"><h2>Потрібно зробити</h2>${renderStudentTaskFeed(pendingTasks.slice(0, 6))}</div></div>
      <div class="card"><h2>Найближчі 7 днів</h2>${renderLessonFeed(nextLessons(8, lessons))}</div>
    `;
  }

  function renderStudentCalendar() {
    const lessons = myLessons();
    return `
      <div class="page-heading"><div><p class="eyebrow">Розклад</p><h1>Мій календар</h1><p class="muted">Статус уроку встановлює викладач. Ти бачиш усі зміни одразу.</p></div></div>
      <div class="calendar-workspace"><div class="card calendar-column"><div class="calendar-actions"><h2>Календар</h2><button class="btn small secondary" data-action="calendar-today">Сьогодні</button></div>${renderCalendar(lessons)}</div><div class="card day-column"><h2>${formatDate(state.selectedDate)}</h2>${renderLessonCards(dayLessons(lessons), false)}</div></div>
    `;
  }

  function renderStudentHomework() {
    const tasks = myHomeworkStudents();
    return `
      <div class="page-heading"><div><p class="eyebrow">Домашні завдання</p><h1>Мої роботи</h1><p class="muted">Надсилай текст або файл і повертайся до коментаря викладача.</p></div></div>
      <div class="list">${tasks.map((item) => renderStudentHomeworkCard(item)).join("") || empty("Домашніх завдань поки немає.")}</div>
    `;
  }

  function renderLessonForm(students) {
    const defaultStart = dateTimeLocal(state.selectedDate, "15:00");
    const defaultEnd = dateTimeLocal(state.selectedDate, "16:00");
    return `
      <form id="createLessonForm" class="stack">
        ${subjectSelect("subjectId", "Предмет", true)}
        <div class="field"><label>Назва заняття</label><input name="title" placeholder="Наприклад, Підготовка до контрольної" required /></div>
        <div class="two-fields"><div class="field"><label>Початок</label><input name="startsAt" type="datetime-local" value="${defaultStart}" required /></div><div class="field"><label>Кінець</label><input name="endsAt" type="datetime-local" value="${defaultEnd}" required /></div></div>
        ${selectField("studentIds", "Учні", students.map((student) => ({ user_id: student.id })), true, null, true)}
        <div class="field"><label>Посилання на зустріч</label><input name="meetingUrl" type="url" placeholder="https://..." /></div>
        <div class="field"><label>Місце / платформа</label><input name="location" placeholder="Zoom, Google Meet або кабінет 12" /></div>
        <button class="btn primary" type="submit">Створити заняття</button>
      </form>
    `;
  }

  function renderLessonPanel(lesson) {
    const participants = lessonStudents(lesson.id);
    const lessonTasks = state.data.homework.filter((task) => task.lesson_id === lesson.id);
    return `
      <div class="lesson-focus">
        <div class="item"><div class="item-head"><div><p class="item-title">${escape(subjectName(lesson.subject_id))} · ${escape(lesson.title)}</p><div class="meta">${escape(formatDateTime(lesson.starts_at))} — ${escape(formatTime(lesson.ends_at))}</div><div class="meta">${escape(participants.map((row) => nameOf(row.student_id)).join(", "))}</div></div>${statusBadge(lesson.status)}</div>${lesson.meeting_url ? `<a href="${escapeAttr(lesson.meeting_url)}" target="_blank" rel="noopener">Відкрити зустріч</a>` : ""}${renderAttachments({ lesson_id: lesson.id })}</div>
        <form id="lessonStatusForm" class="stack" style="margin-top:12px;"><input type="hidden" name="lessonId" value="${lesson.id}" /><div class="field"><label>Статус</label><select name="status">${lessonStatusOptions(lesson.status)}</select></div><div class="field"><label>Нотатки викладача</label><textarea name="teacherNote" placeholder="Що пройшли, що повторити наступного разу">${escape(lesson.teacher_note || "")}</textarea></div><button class="btn secondary" type="submit">Зберегти статус і нотатки</button></form>
        <form id="createHomeworkForm" class="stack filebox" style="margin-top:12px;"><input type="hidden" name="lessonId" value="${lesson.id}" /><strong>Домашнє до цього уроку</strong><div class="field"><label>Назва</label><input name="title" required /></div><div class="field"><label>Опис</label><textarea name="description"></textarea></div><div class="field"><label>Дедлайн</label><input name="deadline" type="datetime-local" /></div><div class="field"><label>Файли</label><input name="files" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.docx" /></div><button class="btn primary" type="submit">Опублікувати домашнє</button></form>
        <form id="lessonAttachmentForm" class="stack filebox" style="margin-top:12px;" data-upload-target="lesson"><input type="hidden" name="lessonId" value="${lesson.id}" /><strong>Матеріали до уроку</strong><input name="files" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.docx" /><button class="btn secondary" type="button" data-action="upload-lesson-files" data-lesson-id="${lesson.id}">Завантажити файли</button></form>
        <div style="margin-top:12px;"><strong>Домашні до уроку</strong>${lessonTasks.length ? `<div class="list" style="margin-top:8px;">${lessonTasks.map((task) => `<div class="item"><p class="item-title">${escape(task.title)}</p><div class="meta">${task.deadline_at ? "Дедлайн: " + escape(formatDateTime(task.deadline_at)) : "Без дедлайну"}</div></div>`).join("")}</div>` : '<div class="meta">Ще не опубліковано.</div>'}</div>
      </div>
    `;
  }

  function renderHomeworkForm(selected) {
    const students = teacherStudents();
    return `
      <form id="createHomeworkForm" class="stack">
        <div class="field"><label>Пов’язати із заняттям</label><select name="lessonId"><option value="">Без прив’язки</option>${state.data.lessons.filter((lesson) => lesson.teacher_id === state.session.user.id).map((lesson) => `<option value="${lesson.id}" ${selected?.id === lesson.id ? "selected" : ""}>${escape(formatDateTime(lesson.starts_at))} · ${escape(lesson.title)}</option>`).join("")}</select></div>
        <div class="field"><label>Назва</label><input name="title" required /></div><div class="field"><label>Опис</label><textarea name="description"></textarea></div><div class="field"><label>Дедлайн</label><input name="deadline" type="datetime-local" /></div>
        ${selected ? "" : selectField("studentIds", "Учні", students.map((student) => ({ user_id: student.id })), true, null, true)}
        <div class="field"><label>Вкладення</label><input name="files" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.docx" /></div><button class="btn primary" type="submit">Опублікувати</button>
      </form>
    `;
  }

  function renderTeacherHomeworkReview(tasks) {
    const rows = tasks.flatMap((task) => homeworkStudents(task.id).map((recipient) => ({ task, recipient }))).filter((row) => row.recipient.status !== "not_started");
    return `<div class="list">${rows.length ? rows.map(({ task, recipient }) => {
      const submissions = submissionsFor(recipient.id);
      return `<div class="item"><p class="item-title">${escape(task.title)} · ${escape(nameOf(recipient.student_id))}</p><div class="meta">Статус: ${submissionLabel(recipient.status)}${recipient.grade ? " · оцінка: " + escape(recipient.grade) : ""}</div>${submissions.map((submission) => `<div class="filebox"><div>${escape(submission.body || "Файли без тексту")}</div>${renderAttachments({ submission_id: submission.id })}</div>`).join("")}${recipient.teacher_comment ? `<div class="meta">Мій коментар: ${escape(recipient.teacher_comment)}</div>` : ""}<form id="feedbackForm" class="stack" style="margin-top:8px;"><input type="hidden" name="homeworkStudentId" value="${recipient.id}" /><div class="two-fields"><div class="field"><label>Статус</label><select name="status"><option value="reviewed">Перевірено</option><option value="needs_revision">На доопрацювання</option></select></div><div class="field"><label>Оцінка</label><input name="grade" placeholder="Наприклад, 11/12" value="${escapeAttr(recipient.grade || "")}" /></div></div><div class="field"><label>Коментар</label><textarea name="comment">${escape(recipient.teacher_comment || "")}</textarea></div><div class="field"><label>Виправлений файл</label><input name="files" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.docx" /></div><button class="btn small secondary" type="submit">Надіслати зворотний зв’язок</button></form></div>`;
    }).join("") : empty("Надісланих робіт ще немає.")}</div>`;
  }

  function renderStudentHomeworkCard(recipient) {
    const task = homeworkById(recipient.homework_id);
    if (!task) return "";
    const submissions = submissionsFor(recipient.id);
    return `
      <article class="card homework-card"><div class="item-head"><div><p class="eyebrow">${task.deadline_at ? "Дедлайн: " + escape(formatDateTime(task.deadline_at)) : "Без дедлайну"}</p><h2>${escape(task.title)}</h2></div>${submissionBadge(recipient.status)}</div><p>${escape(task.description || "Без опису")}</p>${renderAttachments({ homework_id: task.id })}${recipient.teacher_comment ? `<div class="feedback-box"><strong>Коментар викладача</strong><div>${escape(recipient.teacher_comment)}</div>${recipient.grade ? `<div>Оцінка: ${escape(recipient.grade)}</div>` : ""}${renderAttachments({ homework_student_id: recipient.id })}</div>` : ""}${submissions.length ? `<div class="filebox"><strong>Мої відповіді</strong>${submissions.map((submission) => `<div class="meta">${escape(formatDateTime(submission.submitted_at))}: ${escape(submission.body || "Файли")}${renderAttachments({ submission_id: submission.id })}</div>`).join("")}</div>` : ""}<form id="submitHomeworkForm" class="stack" style="margin-top:12px;"><input type="hidden" name="homeworkStudentId" value="${recipient.id}" /><div class="field"><label>Моя відповідь</label><textarea name="body" placeholder="Опиши розв’язання або додай посилання"></textarea></div><div class="field"><label>Файли відповіді</label><input name="files" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.docx" /></div><button class="btn primary" type="submit">Надіслати відповідь</button></form></article>
    `;
  }

  function renderLessonFeed(lessons) {
    return `<div class="list">${lessons.length ? lessons.map((lesson) => `<div class="item"><div class="item-head"><div><p class="item-title">${escape(formatDateTime(lesson.starts_at))} · ${escape(subjectName(lesson.subject_id))}</p><div class="meta">${escape(lesson.title)}</div>${lesson.meeting_url ? `<a href="${escapeAttr(lesson.meeting_url)}" target="_blank" rel="noopener">Перейти до зустрічі</a>` : ""}${renderAttachments({ lesson_id: lesson.id })}</div>${statusBadge(lesson.status)}</div></div>`).join("") : empty("Немає запланованих занять.")}</div>`;
  }

  function renderLessonCards(lessons, selectable) {
    return lessons.length ? lessons.map((lesson) => {
      const content = `<div class="lesson-card-head"><strong>${escape(formatTime(lesson.starts_at))} · ${escape(subjectName(lesson.subject_id))}</strong>${statusBadge(lesson.status)}</div><div>${escape(lesson.title)}</div><div class="meta">${escape(lessonStudents(lesson.id).map((row) => nameOf(row.student_id)).join(", ") || "Без учнів")}</div>${selectable ? "" : renderAttachments({ lesson_id: lesson.id })}`;
      return selectable
        ? `<button class="lesson-card ${state.selectedLessonId === lesson.id ? "active" : ""}" type="button" data-action="select-lesson" data-lesson-id="${lesson.id}">${content}</button>`
        : `<article class="lesson-card">${content}</article>`;
    }).join("") : empty("На цей день занять немає.");
  }

  function renderStudentTaskFeed(tasks) {
    return `<div class="list">${tasks.length ? tasks.map((item) => { const task = homeworkById(item.homework_id); return `<div class="item"><div class="item-head"><div><p class="item-title">${escape(task?.title || "Домашнє")}</p><div class="meta">${task?.deadline_at ? "Дедлайн: " + escape(formatDateTime(task.deadline_at)) : "Без дедлайну"}</div></div>${submissionBadge(item.status)}</div></div>`; }).join("") : empty("Усе виконано.")}</div>`;
  }

  function renderCalendar(lessons) {
    const now = new Date();
    const view = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + state.calendarOffset, 1, 12));
    const year = view.getUTCFullYear();
    const month = view.getUTCMonth();
    const first = new Date(Date.UTC(year, month, 1, 12));
    const firstWeekday = (first.getUTCDay() + 6) % 7;
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
    const cells = [];

    for (let blank = 0; blank < firstWeekday; blank += 1) cells.push('<span class="calendar-day blank" aria-hidden="true"></span>');
    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const count = lessons.filter((lesson) => localDate(lesson.starts_at) === date).length;
      const classes = ["calendar-day"];
      if (date === isoDate(new Date())) classes.push("today");
      if (date === state.selectedDate) classes.push("selected");
      cells.push(`<button type="button" class="${classes.join(" ")}" data-action="select-date" data-date="${date}"><span>${day}</span>${count ? `<b class="calendar-count">${count}</b>` : ""}</button>`);
    }
    while (cells.length % 7) cells.push('<span class="calendar-day blank" aria-hidden="true"></span>');

    return `
      <div class="calendar-header"><button class="icon-btn" type="button" data-action="calendar-prev" aria-label="Попередній місяць">‹</button><strong>${monthTitle(view)}</strong><button class="icon-btn" type="button" data-action="calendar-next" aria-label="Наступний місяць">›</button></div>
      <div class="calendar-weekdays"><span>Пн</span><span>Вт</span><span>Ср</span><span>Чт</span><span>Пт</span><span>Сб</span><span>Нд</span></div>
      <div class="calendar-grid">${cells.join("")}</div>
    `;
  }

  function renderAttachments(target) {
    const files = state.data.attachments.filter((file) => Object.entries(target).every(([key, item]) => file[key] === item));
    if (!files.length) return "";
    return `<div class="attachment-list">${files.map((file) => `<button class="attachment" type="button" data-action="download-file" data-file-id="${file.id}">Завантажити: ${escape(file.original_name)}${file.byte_size ? ` <span>${formatBytes(file.byte_size)}</span>` : ""}</button>`).join("")}</div>`;
  }

  async function uploadInputFiles(form, target) {
    const input = form?.elements?.files;
    const files = input?.files ? Array.from(input.files) : [];
    if (!files.length) return;
    const allowed = new Set([
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ]);

    for (const file of files) {
      const extension = file.name.split(".").pop()?.toLowerCase();
      const allowedExtension = ["pdf", "jpg", "jpeg", "png", "webp", "docx"].includes(extension);
      if (file.size > 10 * 1024 * 1024) throw new Error(`Файл «${file.name}» перевищує ліміт 10 МБ.`);
      if (!allowedExtension || (file.type && !allowed.has(file.type))) throw new Error(`Формат файлу «${file.name}» не підтримується.`);

      const fileName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const random = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const storagePath = `${state.session.user.id}/${random}-${fileName}`;
      const { error: uploadError } = await state.client.storage.from("portal-files").upload(storagePath, file, {
        cacheControl: "3600",
        contentType: file.type || "application/octet-stream",
        upsert: false
      });
      if (uploadError) throw uploadError;

      const { error: attachmentError } = await state.client.rpc("register_file_attachment", {
        p_school_id: state.school.id,
        p_storage_path: storagePath,
        p_original_name: file.name,
        p_mime_type: file.type || null,
        p_byte_size: file.size,
        p_lesson_id: target.lesson_id || null,
        p_homework_id: target.homework_id || null,
        p_submission_id: target.submission_id || null,
        p_homework_student_id: target.homework_student_id || null
      });
      if (attachmentError) {
        await state.client.storage.from("portal-files").remove([storagePath]);
        throw attachmentError;
      }
    }
  }

  async function downloadAttachment(fileId) {
    const file = state.data.attachments.find((item) => item.id === fileId);
    if (!file) throw new Error("Файл більше недоступний.");
    const { data, error } = await state.client.storage.from("portal-files").createSignedUrl(file.storage_path, 60 * 10);
    if (error) throw error;
    window.open(data.signedUrl, "_blank", "noopener");
  }

  async function updateHomeworkStudent(id, changes) {
    const { error } = await state.client.from("homework_students").update(changes).eq("id", id);
    if (error) throw error;
    state.notice = success("Статус роботи оновлено.");
    await refreshContext();
  }

  function renderCurrent() {
    if (state.membership && state.school) renderDashboard();
    else if (state.session) renderOnboarding(null);
    else renderAuth();
  }

  function setLoading(loading) {
    state.loading = loading;
    document.body.classList.toggle("is-loading", loading);
  }

  function value(form, name) {
    return String(new FormData(form).get(name) || "").trim();
  }

  function values(form, name) {
    return Array.from(form.querySelectorAll(`[name="${name}"] option:checked`)).map((option) => option.value).filter(Boolean);
  }

  function wholeUah(raw) {
    const amount = Number(raw);
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Сума має бути цілим числом у гривнях без копійок.");
    return amount;
  }

  function activeMembers(role) {
    return state.data.memberships.filter((member) => member.status === "active" && member.role === role);
  }

  function teacherStudents() {
    const ids = state.data.teacherStudents.filter((relation) => relation.teacher_id === state.session.user.id).map((relation) => relation.student_id);
    return ids.map((id) => state.data.profiles.find((profile) => profile.id === id)).filter(Boolean);
  }

  function myLessons() {
    const ids = new Set(state.data.lessonStudents.filter((item) => item.student_id === state.session.user.id).map((item) => item.lesson_id));
    return state.data.lessons.filter((lesson) => ids.has(lesson.id));
  }

  function myHomeworkStudents() {
    return state.data.homeworkStudents.filter((item) => item.student_id === state.session.user.id).sort((a, b) => {
      const deadlineA = homeworkById(a.homework_id)?.deadline_at || "9999";
      const deadlineB = homeworkById(b.homework_id)?.deadline_at || "9999";
      return deadlineA.localeCompare(deadlineB);
    });
  }

  function teacherHomeworkStudents() {
    const ownHomework = new Set(state.data.homework.filter((item) => item.teacher_id === state.session.user.id).map((item) => item.id));
    return state.data.homeworkStudents.filter((item) => ownHomework.has(item.homework_id));
  }

  function lessonStudents(lessonId) {
    return state.data.lessonStudents.filter((item) => item.lesson_id === lessonId);
  }

  function homeworkStudents(homeworkId) {
    return state.data.homeworkStudents.filter((item) => item.homework_id === homeworkId);
  }

  function submissionsFor(homeworkStudentId) {
    return state.data.submissions.filter((item) => item.homework_student_id === homeworkStudentId).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
  }

  function lessonById(id) {
    return state.data.lessons.find((item) => item.id === id) || null;
  }

  function homeworkById(id) {
    return state.data.homework.find((item) => item.id === id) || null;
  }

  function selectedLesson() {
    return state.selectedLessonId ? lessonById(state.selectedLessonId) : null;
  }

  function dayLessons(lessons) {
    return lessons.filter((lesson) => localDate(lesson.starts_at) === state.selectedDate).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  }

  function nextLessons(limit, source) {
    const now = new Date().toISOString();
    return (source || state.data.lessons).filter((lesson) => lesson.starts_at >= now).sort((a, b) => a.starts_at.localeCompare(b.starts_at)).slice(0, limit);
  }

  function freeSlots(lessons) {
    const free = [];
    for (let hour = 8; hour < 20; hour += 1) {
      const slotStart = new Date(`${state.selectedDate}T${String(hour).padStart(2, "0")}:00:00`);
      const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);
      const occupied = lessons.some((lesson) => new Date(lesson.starts_at) < slotEnd && new Date(lesson.ends_at) > slotStart);
      if (!occupied) free.push(`${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00`);
    }
    return free;
  }

  function walletBalances() {
    return state.data.ledger.filter((row) => row.status === "confirmed").reduce((result, row) => {
      if (!result[row.student_id]) result[row.student_id] = { balance: 0, paid: 0, spent: 0 };
      const item = result[row.student_id];
      item.balance += row.amount_uah;
      if (row.amount_uah > 0) item.paid += row.amount_uah;
      if (row.amount_uah < 0) item.spent += Math.abs(row.amount_uah);
      return result;
    }, {});
  }

  function teacherDailyTotals() {
    const grouped = new Map();
    state.data.ledger.filter((row) => row.status === "confirmed" && row.teacher_id && row.teacher_payout_uah).forEach((row) => {
      const date = localDate(row.created_at);
      const key = `${date}-${row.teacher_id}`;
      const item = grouped.get(key) || { date, teacherId: row.teacher_id, total: 0 };
      item.total += row.teacher_payout_uah;
      grouped.set(key, item);
    });
    return Array.from(grouped.values()).sort((a, b) => `${b.date}${b.teacherId}`.localeCompare(`${a.date}${a.teacherId}`));
  }

  function selectField(name, label, records, required, emptyLabel, multiple) {
    const options = records.map((record) => {
      const id = record.user_id || record.id;
      return `<option value="${escapeAttr(id)}">${escape(nameOf(id))}</option>`;
    }).join("");
    const emptyOption = emptyLabel !== undefined ? `<option value="" selected hidden>${escape(emptyLabel)}</option>` : "";
    return `<div class="field"><label>${escape(label)}</label><select name="${escapeAttr(name)}" ${required ? "required" : ""} ${multiple ? "multiple size=\"4\"" : ""}>${emptyOption}${options}</select>${multiple ? '<div class="meta">Щоб вибрати кількох учнів, утримуй Ctrl або Cmd.</div>' : ""}</div>`;
  }

  function subjectSelect(name, label, required, emptyLabel) {
    const options = state.data.subjects.filter((item) => item.is_active).map((item) => `<option value="${item.id}">${escape(item.name)}</option>`).join("");
    const emptyOption = emptyLabel !== undefined ? `<option value="" selected hidden>${escape(emptyLabel)}</option>` : "";
    return `<div class="field"><label>${escape(label)}</label><select name="${escapeAttr(name)}" ${required ? "required" : ""}>${emptyOption}${options}</select></div>`;
  }

  function renderPeopleList(members) {
    return `<div class="list">${members.map((member) => {
      const isSelf = member.user_id === state.session.user.id;
      return `<div class="item"><div class="item-head"><div><p class="item-title">${escape(nameOf(member.user_id))}</p><div class="meta">${escape(isSelf ? "Цей акаунт" : "Активний доступ")}</div></div><span class="role-badge role-${member.role}">${escape(roleTitle(member.role))}</span></div>${isSelf ? "" : `<form id="changeUserRoleForm" class="inline-form"><input type="hidden" name="userId" value="${member.user_id}" /><select name="role"><option value="student" ${member.role === "student" ? "selected" : ""}>Учень</option><option value="teacher" ${member.role === "teacher" ? "selected" : ""}>Викладач</option><option value="admin" ${member.role === "admin" ? "selected" : ""}>Адміністратор</option></select><button class="btn small secondary" type="submit">Змінити роль</button><button class="btn small secondary" type="button" data-action="suspend-user" data-user-id="${member.user_id}">Призупинити</button><button class="btn small danger" type="button" data-action="delete-user" data-user-id="${member.user_id}">Видалити</button></form>`}</div>`;
    }).join("") || empty("Поки немає активних користувачів.")}</div>`;
  }

  function metricCard(label, number, hint) {
    return `<article class="metric-card"><div class="metric-label">${escape(label)}</div><strong>${escape(String(number))}</strong><div class="meta">${escape(hint)}</div></article>`;
  }

  function empty(message) {
    return `<div class="empty-state">${escape(message)}</div>`;
  }

  function statusBadge(status) {
    const labels = { planned: "Заплановано", completed: "Проведено", cancelled: "Скасовано", cancelled_paid: "Скасовано з оплатою" };
    return `<span class="status status-${escapeAttr(status)}">${escape(labels[status] || status)}</span>`;
  }

  function lessonStatusOptions(selected) {
    return ["planned", "completed", "cancelled", "cancelled_paid"].map((status) => `<option value="${status}" ${status === selected ? "selected" : ""}>${stripHtml(statusBadge(status))}</option>`).join("");
  }

  function submissionBadge(status) {
    return `<span class="submission-status submission-${escapeAttr(status)}">${escape(submissionLabel(status))}</span>`;
  }

  function submissionLabel(status) {
    return { not_started: "Не розпочато", submitted: "На перевірці", needs_revision: "На доопрацюванні", reviewed: "Перевірено" }[status] || status;
  }

  function roleTitle(role) {
    return { admin: "Адміністратор", teacher: "Викладач", student: "Учень" }[role] || role;
  }

  function ledgerLabel(kind) {
    return { payment: "Оплата", lesson_charge: "Списання за урок", refund: "Повернення", adjustment: "Коригування" }[kind] || kind;
  }

  function subjectName(id) {
    return state.data.subjects.find((item) => item.id === id)?.name || "Предмет";
  }

  function nameOf(id) {
    return state.data.profiles.find((profile) => profile.id === id)?.full_name || "Користувач";
  }

  function money(amount) {
    return `${new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 }).format(Number(amount) || 0)} грн`;
  }

  function signedMoney(amount) {
    return `${amount >= 0 ? "+" : "−"}${money(Math.abs(amount))}`;
  }

  function monthKey(value) {
    return isoDate(value).slice(0, 7);
  }

  function localDate(value) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    return dateInTimezone(value, state.school?.timezone || "Europe/Kyiv");
  }

  function dateInTimezone(value, timezone) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
    const find = (type) => parts.find((part) => part.type === type)?.value;
    return `${find("year")}-${find("month")}-${find("day")}`;
  }

  function isoDate(value) {
    return localDate(value);
  }

  function dateTimeLocal(date, time) {
    return `${date}T${time}`;
  }

  function formatDate(value) {
    return new Intl.DateTimeFormat("uk-UA", { timeZone: state.school?.timezone || "Europe/Kyiv", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${value}T12:00:00Z`));
  }

  function formatDateTime(value) {
    return new Intl.DateTimeFormat("uk-UA", { timeZone: state.school?.timezone || "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }

  function formatTime(value) {
    return new Intl.DateTimeFormat("uk-UA", { timeZone: state.school?.timezone || "Europe/Kyiv", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  }

  function monthTitle(value) {
    return new Intl.DateTimeFormat("uk-UA", { timeZone: state.school?.timezone || "Europe/Kyiv", month: "long", year: "numeric" }).format(value);
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }

  function renderNotice() {
    if (!state.notice) return "";
    const notice = state.notice;
    state.notice = null;
    return `<div class="msg ${notice.type}">${escape(notice.message)}</div>`;
  }

  function success(message) { return { type: "success", message }; }
  function failure(message) { return { type: "error", message }; }

  function friendlyError(error) {
    const text = String(error?.message || error?.error_description || error || "Невідома помилка");
    if (text.includes("No active price")) return "Для цього учня немає активного тарифу. Адміністратор має вказати ціну уроку.";
    if (text.includes("Selected student is not assigned")) return "Цей учень не прикріплений до викладача.";
    if (text.includes("overlaps an existing lesson")) return "Цей час перетинається з іншим активним заняттям у твоєму календарі.";
    if (text.includes("Selected subject is unavailable")) return "Обраний предмет недоступний. Онови сторінку та вибери активний предмет.";
    if (text.includes("financial history cannot be deleted")) return "Урок уже має фінансову історію. Замість видалення зміни його статус на «Скасовано».";
    if (text.includes("Access denied")) return "Недостатньо прав для цієї дії.";
    if (text.includes("Email not confirmed")) return "Підтверди email, а потім увійди в кабінет.";
    if (text.includes("Failed to send a request to the Edge Function")) return "Сервіс створення акаунтів ще не підключено. У Supabase відкрий Edge Functions, створи або задеплой функцію з назвою admin-users і повтори спробу.";
    return text;
  }

  function escape(value) {
    return String(value ?? "").replace(/[&<>'\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" }[character]));
  }

  function escapeAttr(value) {
    return escape(value);
  }

  function stripHtml(value) {
    return value.replace(/<[^>]*>/g, "");
  }
})();
